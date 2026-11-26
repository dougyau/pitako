// Trusted assembly supplies config, the library marker and COMPLETE review source.
// No imports, nested async helpers, private store, or artifact-loader host authority.
if (typeof state === "undefined") throw new Error("Explicit native mission binding is required.");
const text = value => typeof value === "string" && value.trim().length > 0;
const string = { type: "string", minLength: 1 };
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const list = items => ({ type: "array", items });
const integer = { type: "integer", minimum: 1 };
const candidateSchema = object({ head: string, fingerprint: string });
const commandSchema = object({ id: string, command: string, cwd: string, timeoutMs: integer });
commandSchema.properties.verifies = list(integer);
const backlogTaskSchema = object({
  id: string, title: { ...string, maxLength: 80 }, goal: string, expectedResult: string, status: { enum: ["pending"] },
  origin: object({ kind: { enum: ["spec", "director", "final-phase", "human"] }, ref: string }),
  specRefs: list(string), dependsOn: list(string), gates: { ...list(commandSchema), minItems: 1, maxItems: EXECUTE_TASK_GATES_MAX },
  metric: nullable(object({ command: string, unit: string, target: { type: "number" } })),
  parent: nullable(string), remaining: { type: "string" },
  progress: object({ nonImproving: { type: "integer", minimum: 0 }, last5: list({ type: "object" }) }),
  history: list({ type: "object" }),
});
const updatePatchSchema = { type: "object", additionalProperties: false,
  properties: Object.fromEntries(["goal", "expectedResult", "specRefs", "dependsOn", "gates", "metric", "remaining", "title"]
    .map(key => [key, backlogTaskSchema.properties[key]])) };
const changeSchema = { anyOf: [
  object({ kind: { const: "add" }, task: backlogTaskSchema, reason: string }),
  object({ kind: { const: "split" }, id: string, tasks: list(backlogTaskSchema), reason: string }),
  object({ kind: { const: "obsolete" }, id: string, reason: string }),
  object({ kind: { const: "update" }, id: string, patch: updatePatchSchema, reason: string }),
] };
const planSchema = object({ select: nullable(string), changes: list(changeSchema), reason: string });
const acceptanceSchema = object({ id: string, command: string, cwd: string });
acceptanceSchema.properties.verifies = list(integer);
acceptanceSchema.properties.exception = object({ humanRef: integer, reason: string });
planSchema.properties.acceptance = list(acceptanceSchema);
const workerSchema = object({
  work: string, status: { enum: ["complete", "continue", "gaps", "blocked"] }, remaining: list(string),
  // Knowledge is advisory: malformed or absent knowledge must not reject work.
  knowledge: {},
});
workerSchema.properties.continuation = object({ mode: { enum: ["resume", "fresh"] }, reason: { type: "string", maxLength: 200 } });
workerSchema.required = ["work", "status", "remaining"];
const demandObservationSchema = object({ memo: string, evidenceLimits: list(string),
  observations: list(object({ source: string, demand: string, reason: string })) });
const complianceSchema = object({
  status: { enum: ["fulfilled", "gaps", "blocked"] }, reason: string,
  requirements: { ...list(object({
    id: string, source: string, reason: string, evidence: list(string), checks: list(string),
    status: { enum: ["fulfilled", "gap", "blocked", "not-applicable"] },
  })), minItems: 1 },
});
const recoverySchema = object({
  status: { enum: ["recovered", "lost", "conflict", "unresolved"] }, reason: string,
  // An exact never-admitted original may be structurally invalid. Retain it
  // verbatim for authority checks and diagnosis, not schema-driven repair.
  original: nullable({ type: "object" }), workerResult: nullable(workerSchema),
  originalAvailable: { type: "boolean" },
  binding: { enum: ["identical", "absent", "changed", "unavailable"] },
  comparison: { enum: ["equal-full-json", "different-full-json", "only-original", "neither"] },
  provenance: list(string),
});
let key = `invoke-${config.invocation}`;
const stateKey = "pitako-execute";
const references = [];
const nativeCalls = [];
function retainNativeCall(promise) {
  nativeCalls.push(promise);
  return promise;
}
const utf8Bytes = value => encodeURIComponent(value).replace(/%[0-9A-F]{2}|[^%]/g, "x").length;
const clone = value => JSON.parse(JSON.stringify(value));
function retainedText(value, { units, bytes }) {
  let result = "", remaining = bytes;
  for (const point of typeof value === "string" ? value.toWellFormed() : "") {
    const size = utf8Bytes(JSON.stringify(point)) - 2;
    if (size > remaining || units !== undefined && result.length + point.length > units) break;
    result += point; remaining -= size;
  }
  return result;
}
const excerpt = value => retainedText(value, { units: 360, bytes: 1080 });
function same(a, b) {
  // JSON object key order is not part of the published definition.
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}
// Pointer paths name only these protocol copy sites, not arbitrary lookups.
function visitContinuationCopies(packet, worker, copy) {
  const frame = packet.taskFrame;
  const attempt = packet.attempt;
  const workerKey = attempt?.key;
  const knowledge = worker && worker.reference?.key === workerKey &&
    text(worker.reference?.runId) && worker.reference.runId === attempt?.launch?.runId
    ? worker.value?.knowledge : undefined;
  const copyKnowledge = source => {
    for (const key of Object.keys(source?.workerKnowledge ?? {}))
      source.workerKnowledge[key] = copy(source.workerKnowledge[key], ["worker", "value", "knowledge"],
        key === workerKey ? knowledge : undefined);
  };
  for (const intention of packet.intentions ?? []) {
    const record = intention.operation === "ledger" && intention.input.record;
    if (record?.kind !== "unit") continue;
    const body = record.body;
    if (body.frame?.intents !== undefined)
      body.frame.intents = copy(body.frame.intents, ["taskFrame", "intents"], frame?.intents);
    if (body.result !== undefined)
      body.result = copy(body.result, ["taskState", "last"], packet.taskState?.last);
    if (body.checkpoint !== undefined)
      body.checkpoint = copy(body.checkpoint, ["lastConfirmed"], packet.lastConfirmed);
    copyKnowledge(body.frame);
  }
  const pause = attempt?.pauseSource;
  if (pause?.checkpoint !== undefined) {
    // The confirmation binds the source key even when the checkpoint is a pointer.
    const ref = pause.confirmation?.checkpointRef;
    const sourceKey = typeof ref === "string" ? ref.split("/").at(-2) : undefined;
    const source = sourceKey && Object.hasOwn(frame?.intents ?? {}, sourceKey) ? frame.intents[sourceKey] : undefined;
    pause.checkpoint = copy(pause.checkpoint, ["taskFrame", "intents", sourceKey],
      source?.key === sourceKey ? source : undefined);
  }
  copyKnowledge(frame);
  return packet;
}
function encodeContinuation(packet, worker) {
  return visitContinuationCopies({ ...packet, version: config.stateVersion }, worker, (source, path, target) => {
    if (target === undefined || !same(source, target)) return source;
    const digest = canonicalDigest(target);
    return canonicalDigest(source) === digest ? { same: path, digest } : source;
  });
}
function decodeLoopIOOutput(receipt) {
  const wire = receipt?.P?.prompt?.execution;
  const baselinePacket = readContinuation(wire?.continuation);
  const closePacket = readContinuation(wire?.foldedContinuation);
  if (baselinePacket == null && closePacket == null) return receipt;
  // Host timeout evidence can be checked again against its original wire digest.
  const P = clone(receipt.P);
  const execution = P.prompt.execution;
  const expand = (source, path, target) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return source;
    const keys = Object.keys(source);
    const hasSame = Object.hasOwn(source, "same");
    const hasDigest = Object.hasOwn(source, "digest");
    const pointer = keys.length === 2 && hasSame && hasDigest && same(source.same, path) &&
      typeof source.digest === "string" && source.digest.length === 64 && /^[a-f0-9]{64}$/.test(source.digest);
    if (!(hasSame || (hasDigest && keys.length === 1))) return source;
    if (!pointer || target === undefined || target && Object.hasOwn(target, "same") ||
        canonicalDigest(target) !== source.digest)
      throw Object.assign(new Error(`Execute continuation pointer integrity mismatch: ${path.join(".")}.`),
        { code: "execute-continuation-integrity" });
    return clone(target);
  };
  const folded = execution.foldedContinuation;
  if (folded) {
    const step = operation => {
      const matches = Array.isArray(receipt.projection?.steps)
        ? receipt.projection.steps.filter(step => step?.operation === operation) : [];
      return matches.length === 1 ? matches[0].result : undefined;
    };
    for (const field of ["worker", "checkpoint"])
      if (folded[field] !== undefined)
        folded[field] = expand(folded[field], ["execution", field], execution[field]);
    if (folded.attempt?.checkpoint !== undefined)
      folded.attempt.checkpoint = expand(folded.attempt.checkpoint, ["execution", "checkpoint"], execution.checkpoint);
    if (folded.requests !== undefined)
      folded.requests = expand(folded.requests, ["projection", "steps", "nextRequests", "result"], step("nextRequests"));
    if (folded.seal !== undefined)
      folded.seal = expand(folded.seal, ["projection", "steps", "seal", "result", "receipt"], step("seal")?.receipt);
  }
  for (const packet of [execution?.continuation, execution?.foldedContinuation]) {
    if (!packet) continue;
    visitContinuationCopies(packet, packet.worker ?? execution.worker, expand);
  }
  return { ...receipt, P };
}
// Pure policy: a retained worker is useful only on this exact, unhalted continuation.
function decideRevival(prev, cfg, peak) {
  const fresh = code => ({ decision: "fresh", code });
  if (prev?.result?.revival?.opinion !== "resume") return fresh("opinion-fresh");
  if (prev.taskId !== cfg.taskId) return fresh("different-task");
  if (prev.checkpoint?.loop !== cfg.loop) return fresh("different-loop");
  if (prev.result.status !== "continue") return fresh("not-continue");
  const receipt = prev.gate?.receipt;
  if (receipt?.stalled || receipt?.progress?.nonImproving >= 3) return fresh("stalled");
  if (cfg.halt || prev.halt) return fresh("halted");
  if (prev.restore) return fresh("restore");
  if (!receipt?.after || !same(cfg.candidate, receipt.after)) return fresh("candidate-changed");
  if (!Number.isFinite(peak) || peak < 0) return fresh("missing-peak");
  if (peak > (cfg.revivalContextPeak ?? 120000)) return fresh("context-peak");
  if (!text(prev.launch?.runId)) return fresh("missing-run");
  if (prev.revival?.decision === "resume" && receipt.progress?.nonImproving !== 0)
    return fresh("revived-no-improvement");
  return { decision: "resume", code: "eligible" };
}
function revivalDelta(descriptor, last, posts, metricSeries) {
  return `Continue the same assigned task; only these inputs changed.
ATTEMPT: ${JSON.stringify({ key: descriptor.key, number: descriptor.number })}
GATE FAILURES: ${JSON.stringify(last?.gateFailures ?? null)}
METRIC SERIES: ${JSON.stringify(metricSeries ?? null)}
NEW BOARD POSTS: ${JSON.stringify(posts)}
PREVIOUS RESULT: ${JSON.stringify(descriptor.continuationRef)}
Write code with edit, write or apply_patch; use bash for commands, tests and builds.
The checkpoint hook re-reads the new attempt intention and journals first-touch paths in this attempt.
Return the same decision-only structured result; an optional continuation opinion is advisory.`;
}
// Only an explicit no-child resume refusal permits replacement. Unknown failures and
// all native barriers stay on the existing observation/recovery route.
function rejectedResume(result) {
  return result?.ok === false && !result.runId && !result.agent &&
    (result.results === undefined || Array.isArray(result.results) && result.results.length === 0) &&
    Object.keys(result).every(field => ["key", "ok", "output", "error", "artifactPaths", "results"].includes(field)) &&
    !barrier(result) &&
    /^(?:Cannot resume:|Run not found\. Provide id or runId\.|Status file not found for async run ')/.test(result.error ?? result.output ?? "");
}
function continuationIdentity(value) {
  // Bounded equality witness, not authority or a substitute for native reports.
  const encoded = JSON.stringify([value.candidate, value.remaining, value.diagnosis, value.revival]);
  let hash = 2166136261;
  for (let index = 0; index < encoded.length; index++) hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619);
  return `${encoded.length}:${hash >>> 0}`;
}
function candidate(value) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value?.head ?? "") ||
      !/^[a-f0-9]{64}$/.test(value?.fingerprint ?? ""))
    throw new Error("Missing checkoutEvidence candidate identity.");
  return { head: value.head, fingerprint: value.fingerprint };
}
function barrier(result, ref) {
  if (!result) return null;
  const cause = settledBarrier(result);
  if (cause) return cause;
  if (ref && Array.isArray(result.results) && !result.results.length && typeof result.output === "string") {
    let lines = result.output.split("\n");
    // 0.83.0 wraps management receipts; neither capacity nor remembered
    // foreground metadata alone proves that this exact run is still active.
    if (lines[0] === `Status target: run ${ref}` &&
        /^Spawn budget:/.test(lines[1] ?? "") && /^Active async capacity:/.test(lines[2] ?? ""))
      lines = lines.slice(3);
    if (lines[0] !== `Run: ${ref}` && lines[0] !== `Nested run: ${ref}`) return null;
    const state = lines.find(line => line.startsWith("State: "))?.slice(7);
    if (["stopped", "interrupted"].includes(state)) return state;
    // Child status occupies its own grammar position, not detachedReason,
    // error, or output text on a completed child's line.
    const childStates = lines.map(line =>
      line.match(/^\d+\. [^,]+ (running|queued|pending|paused|detached|recovery|stopped|interrupted when Pi exited)(?:,| ·|$)/)?.[1] ??
      line.match(/^\s*↳ [^|]* \[[^\]]+\] (running|queued|pending|paused|detached|recovery|stopped|rejected)(?: \||$)/)?.[1]);
    if (childStates.includes("stopped")) return "stopped";
    if (childStates.includes("interrupted when Pi exited")) return "interrupted";
    if (["running", "queued", "pending", "paused", "detached", "recovery", "rejected", "live foreground"].includes(state) ||
        childStates.some(Boolean) || lines.some(line => /^Pending appends: [1-9][0-9]*$/.test(line)))
      return "native management activity";
  }
  return null;
}
function nativeBarrier(cause, ref, settled) {
  const error = new Error(`Positive native barrier: ${cause}`);
  error.nativeBarrier = cause;
  if (ref) error.nativeReference = clone(ref);
  if (ref?.key && text(ref.runId) && ref.agent?.startsWith("pitako.") &&
      settledBarrier(settled) === cause && !["running", "queued", "pending"].includes(cause))
    error.settlementHalt = { ref: { key: ref.key, runId: ref.runId, agent: ref.agent },
      cause, originalDigest: canonicalDigest(clone(settled)) };
  return error;
}
function settledNativeHalt(witness) {
  const status = ["stopped", "interrupted"].includes(witness.cause) ||
    /\.task-(reviewer|synthesis)$/.test(witness.ref.key) ? "cancelled" : "blocked";
  const reason = `${status === "cancelled" ? "Execution cancelled: " : ""}${nativeBarrier(witness.cause).message}`;
  return { status, code: "native-barrier", reason, ...witness };
}
function retainSettledNativeHalt(witness) {
  const { key: producer, runId, agent } = witness.ref;
  retainHaltProducer({ key: producer, runId }, pitakoAgentFamily(agent));
  loop.halt = settledNativeHalt(witness);
}
function retainHaltProducer({ key, runId }, role) {
  inFlight.delete(key);
  inFlight.set(key, { key, runId, role });
}
function loopIOViewOverflow(receipt, ref) {
  const reason = viewOverflowReason(receipt);
  if (!reason) return;
  const producer = ref?.runId && pitakoAgentFamily(ref.agent) === "loop-io" ? { key: ref.key, runId: ref.runId } : null;
  const diagnostic = excerpt(producer ? reason : `Board view overflow native original integrity failure: ${reason}`);
  throw Object.assign(new Error(diagnostic), { viewOverflowHalt: {
    status: "blocked", code: "view-overflow", reason: diagnostic,
    ...(producer ? { ref: producer } : {}), originalDigest: canonicalDigest(clone(receipt)),
  } });
}
function workerInterruptionHalt(action, cause) {
  // Status may no longer expose the original artifact paths. Bind to the
  // launched producer identity; the checkpoint is independently bound at head.
  const cancelled = cause !== "native permission denial";
  return { status: cancelled ? "cancelled" : "blocked", code: "native-barrier", cause,
    reason: `${cancelled ? "Execution cancelled: " : ""}${nativeBarrier(cause).message}`,
    ref: { key: action.key, runId: action.runId, agent: "pitako.worker" } };
}
function directorInterruptionHalt(action, cause) {
  return { status: "cancelled", code: "native-barrier", cause,
    reason: `Execution cancelled: ${nativeBarrier(cause).message}`,
    ref: { key: action.key, runId: action.runId, agent: "pitako.execution-director" } };
}
function closingInterruptionHalt(action, cause) {
  const cancelled = ["stopped", "interrupted"].includes(cause) || /\.task-(reviewer|synthesis)$/.test(action.key);
  return { status: cancelled ? "cancelled" : "blocked", code: "native-barrier", cause,
    reason: `${cancelled ? "Execution cancelled: " : ""}${nativeBarrier(cause).message}`,
    // The digest uses the cursor's family, which is unchanged across the rename.
    ref: { key: action.key, runId: action.runId, agent: `pitako.${action.role ?? "reviewer"}` } };
}
function loopIOHalt(action, cause) {
  return { status: ["stopped", "interrupted"].includes(cause) ? "cancelled" : "blocked",
    code: "native-barrier", cause, reason: nativeBarrier(cause).message,
    // Replay rebuilds this from key and runId alone, so it names the family, not the operation.
    ref: { key: action.key, runId: action.runId, agent: "pitako.loop-io" } };
}
function restorationPendingFailure(ref, interrupted) {
  return { code: "recovery",
    reason: "Restoration remains pending with no new checkpoint evidence; reconcile the exact operation or supply material progress, no replacement writer authorized.",
    ref: interrupted ? { key: ref.key, runId: ref.runId, agent: "pitako.worker" } : clone(ref) };
}
function nativeFailure(childKey, error, result) {
  const message = String(error?.message ?? error);
  // 0.83.0 exposes admission failures as text, not a typed capacity code.
  // Match its complete receipt only at the native call boundary, never model prose.
  const capacity = /^Run fan-out limit reached at .+ \(\d+\/\d+ used; \d+ requested, \d+ remaining\)\. No children from this admission group were started\. Start a new top-level run or raise config\.maxSubagentSpawnsPerRun\.$/.test(message) ||
    /^Active async run capacity exhausted: \d+\/\d+ used\.$/.test(message) ||
    /^Subagent spawn limit reached for this session \(\d+\/\d+ used, \d+ requested\)\. \d+ remaining; the declared run cannot fit, so no children were started\. Grant budget explicitly from the root interactive session or start a new session\.$/.test(message);
  return { code: capacity ? "capacity" : "native-dispatch", reason: excerpt(message),
    ref: result?.runId ? nativeReference(childKey, result) : { key: childKey } };
}
const noRunBarrier = { stop: "stopped", interrupt: "interrupted", permission: "native permission denial" };
function noRunHalt(action, { stage, reason }) {
  const cause = noRunBarrier[stage];
  return { status: stage === "task-review-model" ? "blocked" : !cause ? "partial" :
    cause === "native permission denial" && !/\.task-(reviewer|synthesis)$/.test(action.key) ? "blocked" : "cancelled",
    code: cause ? "native-barrier" : stage, ...(cause ? { cause } : {}), reason, ref: { key: action.key } };
}
function taskReviewModelHalt(key, result, models) {
  const role = key.endsWith(".task-reviewer") ? "taskReviewer" : "taskSynthesis";
  return { status: "blocked", code: "task-review-model",
    reason: excerpt(`pitako.execute.${role} model '${models[role]}' failed: ${result?.error ?? "missing original"}. Fix the setting and start a new invocation; no retry or fallback model.`),
    ref: result?.runId ? nativeReference(key, result) : { key } };
}
function dispatch(requests) {
  let calledNative = false;
  return Promise.resolve().then(() => {
    if (requests.some(request => budgetRejected(request.key))) {
      invocation.budgetRejectedKeys = invocation.budgetRejectedKeys.filter(digest => !requests.some(request => canonicalDigest(request.key) === digest));
      // Consume the no-launch evidence before launch; an uncertain new call must reconcile normally.
      return save();
    }
  }).then(() => {
    const models = requests.filter(request => !["loop-io", "originals-verifier",
      "request-observer", "checkpoint-sealer", "checkout-observer"].includes(pitakoAgentFamily(request.agent)));
    if (!models.length || !invocation?.head) return;
    const request = models[0];
    dispatchedAction = { kind: "launched", key: request.key, runId: null,
      role: pitakoAgentFamily(request.agent) ?? (request.key.includes(".review.") ? "reviewer" : "worker") };
    if (dispatchedAction.role === "worker" && loop?.task)
      dispatchedAction.gateTimeoutMs = gateOperationTimeout(gateTaskFor(loop.task));
    return save();
  }).then(() => {
    calledNative = true;
    return retainNativeCall(runs.all(requests));
  }).then(results => {
    results.forEach((result, index) => {
      const request = requests[index], role = pitakoAgentFamily(request.agent) ??
        (request.key.includes(".review.") ? "reviewer" : "worker");
      if (dispatchedAction?.key === request.key && text(result.runId))
        dispatchedAction.runId = result.runId;
      // A settled worker is still an input until its consuming writer commits.
      if (text(result.runId) && (role === "worker" || role === "loop-io" && barrier(result, request.key) ||
          ["running", "queued", "pending"].includes(result.state)))
        inFlight.set(request.key, { key: request.key, runId: result.runId, role });
      else inFlight.delete(request.key);
    });
    const rejected = results.filter((result, index) => {
      // 0.83.0 strips RunFanoutLimitError's type at the sandbox boundary.
      // Only its complete admission receipt, without a child identity, proves no launch.
      const message = result?.error;
      return result?.ok === false && result.key === requests[index].key && !result.runId && !result.agent &&
        result.output === message && Array.isArray(result.artifactPaths) && !result.artifactPaths.length &&
        Object.keys(result).every(field => ["key", "ok", "output", "error", "artifactPaths"].includes(field)) &&
        /^Run fan-out limit reached at .+ \(\d+\/\d+ used; \d+ requested, \d+ remaining\)\. No children from this admission group were started\. Start a new top-level run or raise config\.maxSubagentSpawnsPerRun\.$/.test(message ?? "");
    });
    if (rejected.length) {
      invocation.budgetRejectedKeys = [...new Set([...(invocation.budgetRejectedKeys ?? []), ...rejected.map(result => canonicalDigest(result.key))])];
      throw Object.assign(new Error(rejected[0].error), { spawnBudgetExhausted: true });
    }
    results.forEach((result, index) => {
      if (!result?.ok) {
        const cause = nativeFailure(requests[index].key, result?.error ?? "Native child failed.", result);
        if (cause.code === "capacity") result.nativeFailure = cause;
      }
    });
    return results;
  }).catch(error => {
    if (error?.spawnBudgetExhausted) throw error;
    if (error?.nativeBarrier || !calledNative) throw error;
    const { key, agent } = requests[0];
    const nativeDispatch = { key, role: pitakoAgentFamily(agent) ?? "reviewer" };
    if (/^Blocked by pi-subagents permission rule:/.test(String(error?.message ?? error)))
      throw Object.assign(nativeBarrier("native permission denial", { key }), { nativeDispatch });
    const cause = nativeFailure(key, error);
    const failure = new Error(cause.reason);
    failure.nativeFailure = cause;
    failure.nativeDispatch = nativeDispatch;
    throw failure;
  });
}
function retainUnstartedDispatch(error, reason) {
  if (!error?.nativeDispatch || error.nativeReference?.runId || error.nativeFailure?.ref?.runId) return false;
  const stage = error.nativeFailure?.code ?? Object.keys(noRunBarrier).find(stage => noRunBarrier[stage] === error.nativeBarrier);
  if (!stage) return false;
  const { key, role } = error.nativeDispatch;
  dispatchedAction = { kind: "launched", key, role, runId: null,
    ...(dispatchedAction?.role === "worker" && role === "worker"
      ? { gateTimeoutMs: dispatchedAction.gateTimeoutMs } : {}) };
  loop.halt = noRunHalt(dispatchedAction, { stage, reason: excerpt(reason) });
  return true;
}
function budgetRejected(childKey) {
  return invocation?.budgetRejectedKeys?.includes(canonicalDigest(childKey));
}
function observeStatus(ref, retainUnknown = false, onUnavailable) {
  return runs.status(ref).catch(error => {
    const message = String(error?.message ?? error);
    const prefix = `Status '${ref}' failed: `;
    const cause = message.startsWith(prefix)
      ? barrier({ results: [], output: message.slice(prefix.length) }, ref) : null;
    if (cause === "interrupted") return { ok: false, state: "interrupted", output: message };
    if (cause) throw nativeBarrier(cause, { key: ref });
    if (/Blocked by pi-subagents permission rule:/.test(message)) throw nativeBarrier("native permission denial", { key: ref });
    const failure = nativeFailure(ref, error);
    if (failure.code === "capacity") {
      const blocked = new Error(failure.reason); blocked.nativeFailure = failure; throw blocked;
    }
    if (onUnavailable) throw onUnavailable(message);
    // Best-effort observer unavailability is unknown, not activity or settlement.
    if (retainUnknown) return { ok: false, state: "unknown", output: message };
  });
}
function observeReplayDirector(director) {
  const target = director.runId ?? director.key;
  return observeStatus(target, true).then(observed => {
    const cause = analysisBarrier(observed, director.runId ?? observed?.runId ?? target) ?? analysisBarrier(observed, target);
    if (cause) throw nativeBarrier(cause, director);
    return observed;
  }).catch(error => {
    const cause = error.nativeBarrier;
    if (["stopped", "interrupted", "native permission denial"].includes(cause)) {
      // Status is not a settlement original; retain the bounded host observation instead.
      error.hostHalt = { stage: cause === "native permission denial" ? "host" : "host-stop",
        reason: excerpt(`Director status observation for ${director.key}: ${error.message}`) };
    }
    throw error;
  });
}
function host(grant, attempt = 1, original = grant) {
  if (!grant) return Promise.reject(new Error("Missing trusted inspection grant."));
  let receipt;
  return retainNativeCall(runs.host(grant.key, { kind: "command", command: grant.command, timeoutMs: 86400000 })).then(result => {
    receipt = result;
    if (text(result.outputPath)) references.push({ key: grant.key, outputReference: result.outputPath });
    if (barrier(result)) throw nativeBarrier(barrier(result));
    if (!result.ok) throw new Error([result.error || "Read-only inspection failed.", result.stderr].filter(Boolean).join("\n"));
    const value = JSON.parse(result.stdout);
    // The fixed inspector transports even failed reads in a successful bounded JSON envelope.
    if (text(value.error) && transientSaveError(new Error(value.error)))
      throw new Error([value.error, value.next].filter(Boolean).join(" "));
    const { version, binding, checkout, error, next } = value;
    inspectedEpochAdmission = { version, binding, checkout, error, next };
    if (value.checkpointObservation && typeof value.checkpointObservation === "object") {
      const output = /\/outputs\/([a-f0-9-]{36})\/host\/(inspect-initial(?:\.r[12])?)\.log$/.exec(result.outputPath ?? "");
      if (output?.[2] === grant.key)
        checkpointWitnessRefs.set(value.checkpointObservation, { key: output[2], runId: output[1] });
    }
    return value;
  }).catch(error => {
    // The native wrapper discards the receipt on failure. This exact message at
    // this boundary is compatible with abort, but identical command output can
    // produce it too: retain the ambiguity, never manufacture a Stop receipt.
    if (/^Blocked by pi-subagents permission rule:/.test(String(error?.message ?? error)))
      error.nativeBarrier = "native permission denial";
    const message = String(error?.message ?? error);
    const transient = transientSaveError(error) || /(?:^|[\s:])(ECONNRESET|ECONNREFUSED|EPIPE)(?=[:\s,]|$)/.test(message) ||
      /^Host command '[^']+' failed: Command timed out after \d+ms\.$/.test(message);
    const next = config.inspections.find(item => item.key === `${original.key}.r${attempt}`);
    if (transient && !error.nativeBarrier &&
        !["queued", "running", "pending", "stopped", "interrupted"].includes(receipt?.state) && attempt < 3 && next)
      return host(next, attempt + 1, original);
    const status = ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked";
    const diagnostic = message === `Host command '${grant.key}' failed: Command stopped because the workflow was aborted.`
      ? "Native host abort/failure observation is ambiguous"
      : "Read-only host inspection failed";
    error.hostHalt = { stage: status === "cancelled" ? "host-stop" : "host",
      reason: excerpt(`${diagnostic}: ${error.nativeBarrier ? `${error.nativeBarrier}: ` : ""}${attempt === 3
        ? "Three inspection attempts failed: " : ""}${message}`) };
    error.hostRef = { key: grant.key };
    throw error;
  });
}
function hostHaltReport(action, { stage, reason }) {
  const ref = action?.kind === "pending" ? { key: action.opKey } :
    action?.kind === "launched" ? { key: action.key, runId: action.runId } : undefined;
  return { status: stage === "host-stop" ? "cancelled" : "blocked", code: "host-observation",
    reason, ...(ref ? { ref } : {}) };
}
function hostHaltCursor(cursor, diagnostic) {
  return { ...diagnostic, digest: canonicalDigest({ action: clone(cursor.action),
    command: config.inspections[0].command, halt: hostHaltReport(cursor.action, diagnostic) }) };
}
function hostHaltDisposition(cursor, halt) {
  return { ...cursorDisposition(cursor, halt.status, halt.reason), loopReport: { halt },
    action: { actor: "native run operator", operation: "continue only in a new invocation",
      reason: halt.reason, references: halt.ref ? [halt.ref] : [], started: false } };
}
function matchesCursorRequest(cursor) {
  const preliminary = config.preliminary;
  const association = { missionId: config.missionId, missionPath: config.missionPath,
    invocation: config.invocation, root: preliminary?.root, commonDir: preliminary?.commonDir,
    source: preliminary?.source, digest: preliminary?.digest,
    maxCycles: cursor.budget.maxCycles, sourceRefs: config.sourceRefs ?? [] };
  return preliminary?.binding === cursor.admissionBinding &&
    canonicalDigest(association) === cursor.associationDigest;
}
function checkAdmissionBinding(current) {
  const preliminary = config.preliminary;
  if (!preliminary || preliminary.version !== 1 || current.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(current.binding ?? "") || current.binding !== preliminary.binding ||
      preliminary.id !== config.id || typeof preliminary.content !== "string" ||
      !preliminary.content || utf8Bytes(preliminary.content) > 39936 || !candidate(current.checkout))
    throw new Error(`Preliminary/native admission binding mismatch for ${preliminary?.source ?? "unavailable source"}; expected ${preliminary?.binding ?? "unavailable"}, observed ${current.binding ?? "unavailable"}. Reconcile the disputed selection, content and physical identity; explicitly prepare admission with the intended version, never auto-select newer content. After admission preserve the original snapshot and restore reliable exact bytes; deliver desired changes as a human addendum. Native barriers still require native reconciliation.`);
  return preliminary;
}
function capture(current, proof = refreshedTimeoutAdmission ?? config) {
  const preliminary = checkAdmissionBinding(current);
  const readFailure = current.storeFailure ?? proof.preliminaryStoreFailure;
  if (readFailure && !recoveredEpochCursor)
    throw Object.assign(new Error(readFailure.reason), { code: readFailure.code });
  if (!recoveredEpochCursor && (proof.recovery?.digest !== current.recoveryDigest ||
      current.recoveryDigest !== undefined && !/^[a-f0-9]{64}$/.test(current.recoveryDigest)))
    throw new Error(`Retained recovery originals changed between preliminary capture and native admission; expected ${proof.recovery?.digest ?? "unavailable"}, observed ${current.recoveryDigest ?? "unavailable"}. Preserve exact producer references and the admitted snapshot; inspect those originals and reconcile the exact pending operation, never redispatch or silently recapture.`);
  if (!recoveredEpochCursor && (proof.timeoutRecovery?.digest !== current.timeoutDigest ||
      proof.timeoutRecovery && (canonicalDigest(proof.timeoutRecovery.packet) !== current.timeoutDigest ||
        utf8Bytes(JSON.stringify(proof.timeoutRecovery.packet)) > 61440)))
    throw new Error("Timeout projection preliminary/native digest integrity mismatch.");
  const witness = recoveredEpochCursor ? undefined : current.checkpointObservation;
  if (witness !== undefined && (!witness || typeof witness !== "object" || Array.isArray(witness) ||
      !text(witness.key) || !text(witness.taskId) || !Number.isSafeInteger(witness.attempt) || witness.attempt < 1 ||
      !Number.isSafeInteger(witness.loop) || witness.loop < 1 || !Number.isSafeInteger(witness.cursor) || witness.cursor < 0 ||
      !(Object.keys(witness).sort().join(",") === "attempt,cursor,evidence,key,loop,taskId" && /^[a-f0-9]{64}$/.test(witness.evidence) ||
        Object.keys(witness).sort().join(",") === "attempt,cursor,error,key,loop,taskId" && text(witness.error))))
    throw new Error("Invalid native checkpoint observation; retain the pending unit and inspect the exact native admission receipt before recovery.");
  return { metadata: { root: preliminary.root, commonDir: preliminary.commonDir,
    selected: { source: preliminary.source, digest: preliminary.digest }, checkout: current.checkout,
    retainedAnalyses: recoveredEpochCursor ? [] : proof.recovery?.originals ?? [],
    ...(!recoveredEpochCursor && proof.timeoutRecovery
      ? { timeoutProjection: decodeLoopIOOutput(proof.timeoutRecovery.packet) } : {}),
    ...(witness ? { checkpointObservation: witness } : {}) }, content: preliminary.content };
}
const checkpointWitnessRefs = new WeakMap();
let invocation, loop, activePlan, currentCandidate, checkpointObservation, replay = false;
let storeProjection;
let replayAdmissionObservation;
let inspectedEpochAdmission;
let retainedAnalysisDeadline;
let refreshedTimeoutAdmission;
let recoveredEpochCursor;
let dispatchedAction;
const inFlight = new Map();
let hostHalt;
let retiringAnalysis;
let inspectedAnalyses = [];
let admissionValidated = false;
let persistenceFailed = false;
let persistenceReason = null;
let saveTail = Promise.resolve();
function deterministicSaveError(error) {
  return /256 KiB limit|^Invalid mission state file |must contain only JSON|state key must/.test(String(error?.message ?? error));
}
function transientSaveError(error) {
  const message = String(error?.message ?? error);
  // Native workflow responses retain messages, not errno/type (scripted-workflow.js:1321).
  if (deterministicSaveError(error)) return false;
  return /^Timed out acquiring mission state lock '[^']+'\.$/.test(message) ||
    /(?:^|[\s:])(EAGAIN|EBUSY|EIO|EINTR|ETIMEDOUT|ENOSPC|EDQUOT|EMFILE|ENFILE|EACCES|EPERM)(?=[:\s,]|$)/.test(message);
}
function persistState(stateKey, value) {
  validateExecuteCursor(stateKey, value);
  // Freeze once and serialize saves: a retried older projection must not overwrite a newer receipt.
  const frozen = clone(value);
  function writeProjection(attempt = 1) {
    return Promise.resolve().then(() => state.set(stateKey, frozen)).catch(error => {
      if (!transientSaveError(error)) throw Object.assign(error, {
        terminalPersistence: deterministicSaveError(error),
      });
      if (attempt === 3) throw new Error(`Three state-save attempts failed: ${String(error?.message ?? error)}`);
      // set re-reads disk under its lock; get is cached and cannot confirm a failed write.
      return writeProjection(attempt + 1);
    });
  }
  const pending = saveTail.then(() => writeProjection());
  saveTail = pending.catch(() => {});
  return pending;
}
function maxCycles() { return invocation?.association?.maxCycles ?? null; }
const prettyBytes = value => utf8Bytes(JSON.stringify(value, null, 2));
function executeCursor() {
  const operation = storeProjection?.P.control.operation;
  if (!operation) throw new Error("Execute cursor requires a committed operation reference.");
  const input = committedIntentReference(operation.input, invocation.head);
  const attempt = loop?.attempt;
  const integrated = loop?.integratedReview;
  const closingSlots = integrated ? new Map(integrated.originals.map(original => [original.key, {
    key: original.key, runId: original.runId ?? null, phase: original.phase ?? integrated.phase,
    digest: original.digest ?? loop.closingSeed?.digests[original.key] ??
      (original.failedOriginal === undefined ? null : canonicalDigest(original.failedOriginal)),
  }])) : null;
  if (closingSlots && loop?.halt?.class === "final-review")
    for (const call of loop.analysisCalls ?? [])
      if (call.key.startsWith(reviewPrefix()) && !closingSlots.has(call.key))
        closingSlots.set(call.key, { key: call.key, runId: call.ref.runId ?? null, phase: integrated.phase, digest: null });
  const taskReview = attempt?.taskReview ? { generation: 1, phase: "task",
    slots: [attempt.launch && { ...attempt.launch, phase: "worker" },
      ...(loop.analysisCalls ?? []).filter(call => call.key.startsWith(`${attempt.key}.`) &&
        /\.task-(reviewer|synthesis)$/.test(call.key)).map(call => ({ ...call.ref, phase: "reviewer" }))]
      .filter(Boolean).map(ref => ({ key: ref.key, runId: ref.runId ?? null, phase: ref.phase, digest: null })),
    verifier: null } : loop?.taskReviewCursor;
  const stageDigest = value => value ? {
    stage: value.stage ?? value.code ?? "halted", digest: canonicalDigest(value),
  } : null;
  const replay = { op: operation.operation, opKey: operation.key, input };
  const timedOutReviewer = loop?.halt?.code === "timeout" && pitakoAgentFamily(loop.halt.ref?.agent) === "reviewer" &&
    text(loop.halt.ref.runId) ? loop.halt.ref : null;
  const action = timedOutReviewer
    ? { kind: "launched", role: "reviewer", key: timedOutReviewer.key, runId: timedOutReviewer.runId, input }
    : dispatchedAction?.kind === "pending"
    ? { ...dispatchedAction, input: dispatchedAction.input ? committedIntentReference(dispatchedAction.input, invocation.head) : input }
    : !loop?.halt && (loop?.outcome === "gaps" && invocation.consumedLoops >= maxCycles() || loop?.outcome === "complete")
    ? { kind: "terminal" }
    : dispatchedAction ? { ...dispatchedAction, input }
      : { kind: "pending", ...replay };
  if (action.kind === "launched" && action.role === "worker" &&
      action.gateTimeoutMs === undefined && loop?.task)
    action.gateTimeoutMs = gateOperationTimeout(gateTaskFor(loop.task));
  if (action.kind === "launched" && action.role === "worker")
    action.op = operation.operation;
  if (action.kind === "pending" && ["gate", "close"].includes(action.op) &&
      action.gateTimeoutMs === undefined && loop?.task)
    action.gateTimeoutMs = gateOperationTimeout(gateTaskFor(loop.task));
  if (action.kind === "pending" && action.op === "gate" && loop?.task) {
    action.gateTimeouts = loop.task.gates.map(gate => gate.timeoutMs ?? 1800000);
    action.gateMetricMs = loop.task.metric ? 1800000 : 0;
  }
  const noRunStage = action.kind === "launched" && action.runId === null &&
      same(loop?.halt?.ref, { key: action.key })
    ? loop.halt.code === "native-barrier"
      ? Object.keys(noRunBarrier).find(stage => noRunBarrier[stage] === loop.halt.cause)
      : ["capacity", "native-dispatch", "task-review-model"].includes(loop.halt.code) ? loop.halt.code : null
    : null;
  return {
    version: config.stateVersion, storeId: invocation.storeId, root: invocation.association.root,
    invocation: config.invocation, epoch: invocation.epoch ?? 0,
    associationDigest: canonicalDigest(invocation.association), admissionBinding: invocation.admissionBinding,
    head: clone(invocation.head), action,
    loop: loop ? { number: loop.number, phase: loop.phase, cursor: loop.cursor,
      taskId: loop.task?.id ?? attempt?.taskId ?? null, outcome: loop.outcome ?? null,
      attempt: attempt ? { number: attempt.number, stage: attempt.stage,
        intent: attempt.intent ?? null, revival: attempt.revival?.code ?? null } : null } : null,
      inFlight: [...inFlight.values()], halt: noRunStage
      ? { stage: noRunStage, digest: canonicalDigest(loop.halt), reason: loop.halt.reason }
      : loop?.halt?.code === "native-barrier" && loop.halt.originalDigest
      ? { stage: "native-settlement", digest: canonicalDigest(loop.halt) }
      : loop?.halt?.cause === "native permission denial" &&
      (action.kind === "pending" && ["close", "drain"].includes(action.op) ||
        action.kind === "launched" && action.role === "reviewer" && action.runId &&
        ["review", "compliance"].includes(loop.phase) && loop.halt.ref?.runId === action.runId &&
        loop.halt.ref.key === action.key)
      ? { stage: "native-permission", digest: canonicalDigest(loop.halt) }
      : action.kind === "launched" && action.role === "worker" && action.runId &&
        loop?.halt?.code === "native-barrier" && ["running", "queued", "pending"].includes(loop.halt.cause)
      ? { stage: "worker-activity", digest: canonicalDigest(loop.halt) }
      : loop?.halt?.code === "native-barrier" && ["running", "queued", "pending"].includes(loop.halt.cause) &&
        inFlight.get(loop.halt.ref?.key)?.role === "checkpoint-sealer"
      ? { stage: "sealer-activity", digest: canonicalDigest(loop.halt) } : stageDigest(loop?.halt),
    hostHalt: hostHalt ? hostHaltCursor({ action }, hostHalt) : null,
    timeouts: { ...effectiveTimeouts(),
      ...(action.kind === "launched" && action.runId === null && action.key === retainedAnalysisDeadline?.key
        ? { reviewerMs: retainedAnalysisDeadline.ms } : {}) },
    models: { taskReviewer: invocation.taskReviewer, taskSynthesis: invocation.taskSynthesis,
      ...Object.fromEntries(["r1", "r2", "synthesis"].map(slot => [slot, invocation.reviewModels[slot].model])) },
    budget: { consumedLoops: invocation.consumedLoops, maxCycles: maxCycles(),
      rejectedKeys: invocation.budgetRejectedKeys ?? [], lastProgress: invocation.lastBudgetProgress ?? null },
    backlogDigest: invocation.backlogDigest, boardTopicId: invocation.boardTopicId,
    review: integrated ? {
      generation: loop.analysisGenerations?.["final-review"] ?? 1,
      phase: integrated.phase,
      slots: [...closingSlots.values()],
      verifier: null,
    } : taskReview ?? null,
  };
}
function save(budgetOnly = false) {
  // Before the first advance COMMIT, relaunch repeats its native key; no cursor exists yet.
  if (!invocation?.head) return Promise.resolve();
  // Until the replacement launch-intention save, the verified timeout is the
  // replay point. A cursor naming neither generation cannot rebuild the prompt.
  if (retiringAnalysis) {
    if (dispatchedAction?.kind !== "launched" ||
        !dispatchedAction.key.startsWith(retiringAnalysis) || dispatchedAction.runId)
      return Promise.resolve();
    retiringAnalysis = undefined;
  }
  // Before the replacement baseline commits, only the interrupted source is
  // durable. A cursor must not combine that launch with the successor slot.
  if (loop?.attempt?.restore && !loop.attempt.intent &&
      dispatchedAction?.kind === "launched" && dispatchedAction.role === "worker" &&
      dispatchedAction.key === loop.attempt.restore.producer.key)
    return Promise.resolve();
  // Keep the launched cursor authoritative until the existing grouped drain commits admission.
  // A committed close or baseline reconstructs the pending unit on replay.
  // A Stop on the drain itself must survive; its native producer pins the request.
  const stoppedDrain = dispatchedAction?.kind === "pending" && dispatchedAction.op === "drain" &&
    loop?.halt?.code === "native-barrier" && inFlight.has(loop.halt.ref?.key);
  if (!stoppedDrain && !loop?.attempt?.foldedBaseline && !(
      loop?.attempt?.intent && loop.attempt.baselineIO?.stage === "receipt") &&
      (invocation.sealPending?.record.kind === "unit" ||
      invocation.intentions?.some(entry => entry.operation === "ledger" && entry.input.record.kind === "unit"))) {
    if (budgetOnly === true) return state.get(stateKey).then(cursor => {
      if (!cursor || cursor.invocation !== config.invocation || cursor.storeId !== invocation.storeId)
        throw new Error("Missing retained action for spawn-budget save.");
      return persistState(stateKey, { ...cursor, halt: loop?.halt
        ? { stage: loop.halt.code, digest: canonicalDigest(loop.halt) } : cursor.halt,
        budget: { ...cursor.budget, rejectedKeys: clone(invocation.budgetRejectedKeys),
          lastProgress: invocation.lastBudgetProgress } });
    });
    return Promise.resolve();
  }
  if (loop?.attempt?.stage === "launched")
    committedIntentReference(loop.attempt.intent, invocation.head);
  if ((loop?.phase === "closing" && !loop.closing || loop?.outcome === "gaps") && !loop.archivePending && !loop.archived)
    loop.archivePending = frozenLoopArchive(loop.phase !== "closing");
  if (loop?.phase === "closing" && loop.archivePending && !loop.archived) closingRecord();
  // The native setter measures the entire merged file, including unrelated keys.
  return persistState(stateKey, executeCursor()).then(() => { emitTodoSnapshot(); }).catch(error => {
    persistenceFailed = true;
    persistenceReason = `Essential persistence failed; dispatch halted: ${String(error?.message ?? error)}`;
    throw Object.assign(new Error(persistenceReason), { terminalPersistence: error.terminalPersistence === true });
  });
}
// Display snapshots contain no evidence, prompts or clocks; repeated saves are not heartbeats.
let todoSeq = 0, lastTodoSnapshot;
function emitTodoSnapshot() {
  if (persistenceFailed || typeof emit !== "function" || !loop || !invocation?.association) return;
  const line = value => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const admitted = loop.plan?.stage === "admitted";
  const planCancelled = !admitted && (loop.plan?.stage === "rejected" || loop.halt || loop.outcome);
  const phase = (name, title, status, reason) => ({ name,
    subject: `Loop ${loop.number}/${maxCycles()} · ${title}`, status, metadata: { protected: true },
    ...(reason ? { reason: line(reason) } : {}) });
  const phases = [phase("plan", "Plan", admitted ? "completed" : planCancelled ? "cancelled" : "in_progress",
    planCancelled ? loop.plan?.rejection?.diagnostic ?? loop.halt?.reason ?? loop.outcome : null)];
  if (loop.review || ["review", "compliance", "closing", "finished"].includes(loop.phase))
    phases.push(phase("review", "Review compartido", loop.phase === "review" && !loop.halt ? "in_progress"
      : loop.review?.status === "completed" ? "completed" : "cancelled", loop.review?.reason));
  if (loop.compliance || loop.phase === "compliance")
    phases.push(phase("compliance", "Compliance", loop.phase === "compliance" && !loop.halt ? "in_progress"
      : loop.compliance?.status === "fulfilled" ? "completed" : "cancelled", loop.compliance?.reason));
  const tasks = admitted ? selectedTasks().map(task => {
    const retained = invocation.tasks[task.id];
    const attempt = loop.attempt?.taskId === task.id ? loop.attempt : null;
    const running = attempt?.launch && !["result", "settled"].includes(attempt.stage);
    const status = retained?.completed ? "completed" : running ? "in_progress" : retained?.cancel ? "cancelled" : attempt ? "in_progress" : "pending";
    // Worker steps come from the child session through the main-session projection, not this snapshot.
    const progress = loop.metricSeries ?? loop.task?.progress;
    const samples = progress?.last5 ?? [], latest = samples.at(-1);
    const receipt = attempt?.gate?.receipt;
    const gatesPassed = receipt ? receipt.gates.filter(gate => gate.status === "pass").length : latest?.gatesPassed ?? 0;
    const gatesTotal = task.gates?.length ?? task.checks.length;
    const metric = task.metric ? `metric ${samples[0]?.value ?? "?"}→${latest?.value ?? "?"}/${task.metric.target} · ` : "";
    const stalls = (loop.task?.progress?.stalls ?? 0) + (loop.settlement?.applied && loop.metricSeries?.nonImproving >= 3 && !retained?.completed ? 1 : 0);
    const suffix = `${attempt ? ` (intento ${attempt.number}${attempt.revival?.decision === "resume" ? " ↻" : ""}) · paths ${attempt.capturedPaths ?? 0}` : ""} · ${metric}gates ${gatesPassed}/${gatesTotal} · stall ${progress?.nonImproving ?? 0}/3 · stalls ${stalls}/2`;
    return { id: task.id, status, subject: (task.title ?? task.id).slice(0, 2000 - suffix.length) + suffix,
      blockedBy: task.dependsOn.filter(dependency => !invocation.tasks[dependency.taskId]?.completed).map(dependency => dependency.taskId),
      metadata: { cancel: "request" }, ...(retained?.cancel ? { reason: line(retained.cancel.reason) } : {}) };
  }) : [];
  const active = admitted && loop.phase === "implementation" && loop.attempt && loop.attempt.stage !== "result"
    ? { taskId: loop.attempt.taskId, attempt: loop.attempt.number, workflowKey: loop.attempt.key } : null;
  const notice = originalProblem();
  const verified = notice.criteria?.filter(item => item.status !== "not-run")
    .map(item => `#${item.criterion} ${item.check.id} ${item.status === "passed" ? "pasó" : "falló"} en loop ${item.loop}, candidato ${item.candidate.head.slice(0, 7)}`).join("; ");
  const snapshot = { schema: "pitako.execute-todo", v: 1, invocation: config.invocation,
    loop: loop.number, maxLoops: maxCycles(), phases, tasks, active, outcome: loop.outcome ?? null,
    // Completed rows are sticky and in_progress is reserved for active work, so the notice
    // stays pending (its subject carries the state) until the invocation completes.
    ...(notice.status === "unknown" ? {} : { originalProblem: notice.status === "fulfilled"
      ? { status: loop.outcome === "complete" ? "completed" : "pending", subject: `Problema original · cumplido (${verified}) · seguir, cortar o cerrar como entrega parcial`.slice(0, 2000) }
      : { status: "pending", subject: `Problema original · no cumplido (${verified})`.slice(0, 2000) } }) };
  if (same(snapshot, lastTodoSnapshot)) return;
  lastTodoSnapshot = clone(snapshot);
  emit({ ...snapshot, seq: ++todoSeq });
}
// Each observation gets a fresh durable key: native child reuse must not cache a file read.
function observeMainRequests(cursor = 0, records = [], settling = false, supplied) {
  if (cursor === 0 && loop.cancellationInput) return persistCancellations().then(() => observeMainRequests());
  if (supplied) return admitRequests(supplied, cursor, records, settling);
  invocation.requestObservation = (invocation.requestObservation ?? 0) + 1;
  const observerKey = `${key}.l${loop.number}.requests-${invocation.requestObservation}`;
  const task = JSON.stringify({ invocation: config.invocation, cursor,
      storeId: invocation.storeId, expectedHead: clone(invocation.head),
      ...(invocation.epoch > 0 ? { epoch: invocation.epoch } : {}),
      ...(loop.attempt?.taskReview?.synthesis ? { observation: { key: observerKey,
        number: invocation.requestObservation, input: storeProjection.P.control.operation.input } } : {}) });
  const observe = (retry = 0) => dispatch([{ key: retry ? `${observerKey}.r${retry}` : observerKey, agent: "pitako.request-observer",
    context: "fresh", cwd: config.root, task,
    output: false, outputMode: "inline", outputSchema: false, reads: false, progress: false,
  }]).then(([result]) => {
    const ref = nativeReference(observerKey, result);
    references.push(ref);
    const cause = barrier(result);
    if (cause) throw nativeBarrier(cause, ref, result);
    if (!result?.ok || result.agent !== "pitako.request-observer" || !text(result.runId) ||
        !Array.isArray(result.results) || result.results.length !== 1 || result.results[0].exitCode !== 0 ||
        typeof result.output !== "string" || utf8Bytes(result.output) > 65536 ||
        [result, ...result.results].some(item => item.error || item.outputPartial || item.truncation || item.timedOut || item.processSignal))
      throw new Error("Execute request observation lacks a complete successful result; no worker dispatched.");
    const page = JSON.parse(result.output);
    if (page?.code === "store-busy" && retry < 2) return observe(retry + 1);
    if (page?.code) throw Object.assign(new Error(page.reason), { code: page.code, recovery: page.recovery });
    return admitRequests(page, cursor, records, settling);
  });
  return save().then(() => observe());
}
function admitRequests(page, cursor = 0, records = [], settling = false) {
    if (page.version !== 1 || page.ok !== true || page.invocation !== config.invocation ||
        !Array.isArray(page.requests) || page.requests.some(request => request.v !== 1 ||
          request.invocation !== config.invocation || !text(request.requestId) || !text(request.taskId) ||
          !["cancel", "delete"].includes(request.kind) || !/^[a-z][a-z0-9_-]{0,31}$/.test(request.origin ?? "")) ||
        !(page.next === null || Number.isSafeInteger(page.next) && page.next === cursor + page.requests.length && page.next > cursor))
      throw new Error(`Invalid execute request observation: ${page.reason ?? "invalid page"}; no worker dispatched.`);
    if (page.observed && (Object.keys(page.observed).sort().join(",") !== "count,next,requested,taskId" ||
        !Number.isSafeInteger(page.observed.count) || page.observed.count <= page.requests.length ||
        !text(page.observed.taskId) || typeof page.observed.requested !== "boolean" ||
        !(page.observed.next === null || page.observed.next === cursor + page.observed.count)))
      throw new Error("Invalid execute request wire window; no worker dispatched.");
    records.push(...page.requests);
    if (page.next !== null) return observeMainRequests(page.next, records, settling);
    invocation.lastRequestPage = { ...page, requests: clone(records) };
    for (const request of records) {
      const taskId = loop.task?.id ?? invocation.transitionReplay?.taskId;
      const retained = request.taskId === taskId && invocation.tasks[taskId];
      if (!retained || retained.cancel || retained.completed) continue;
      retained.cancel = { requestId: request.requestId, origin: request.origin, kind: request.kind,
        reason: `cancelled by main-session request (origin: ${request.origin}; ${request.kind})` };
      (invocation.pendingCancellations ??= []).push({ taskId, requestId: request.requestId,
        origin: request.origin, kind: request.kind });
    }
    // A settled worker's effective result is admitted before deciding late cancellation.
    return save().then(() => (settling || loop.attempt?.launch && !loop.attempt.result) ? undefined : persistCancellations());
}
function persistCancellations() {
  if (!invocation.pendingCancellations?.length) return Promise.resolve();
  return (invocation.sealPending ? archiveSeal() : Promise.resolve())
    .then(() => loop.attempt?.result?.status === "complete" ? settleTask() : undefined)
    .then(() => {
      loop.cancellationInput ??= { operation: "apply", root: config.root, specId: config.id,
        expectedDigest: invocation.backlogDigest, key: `${key}.l${loop.number}.cancel-${invocation.requestObservation}`,
        invocation: config.invocation, loop: loop.number, authority: backlogAuthority(),
        director: { select: null, changes: [], reason: "Persist main-session cancellation requests" },
        cancellations: clone(invocation.pendingCancellations) };
      return save();
    }).then(() => {
      // An admitted drain is replayed from its receipt; re-queueing it would orphan its chained digest.
      if (loop.cancellation?.stage === "receipt") return;
      queueApply("cancellation", loop.cancellationInput);
      return save().then(() => groupedIO(`cancellationDrain${invocation.requestObservation}`, { operation: "drain" }));
    }).then(() => {
      const value = loop.cancellation.receipt;
      invocation.backlogDigest = value.digest; invocation.currentView = null;
      invocation.excludedScope = Object.fromEntries(value.cancelledScope.map(task => [task.id, task]));
      for (const task of value.cancelledScope) {
        if (invocation.tasks[task.id]) invocation.tasks[task.id].cancel = clone(task.cancel);
      }
      invocation.pendingCancellations = [];
      delete loop.cancellation; delete loop.cancellationInput;
      return save();
    });
}
// Advisory notice only: designated workflow gates, never worker-reported evidence.
function recordOriginalProblem(task, receipt, descriptor) {
  const criteria = config.originalProblem?.criteria;
  if (!Array.isArray(criteria) || !receipt || receipt.mutated ||
      !same(candidate(receipt.after), currentCandidate)) return;
  for (const criterion of criteria) {
    const marked = receipt.gates.filter(gate =>
      task.gates.find(definition => definition.id === gate.id)?.verifies?.includes(criterion));
    const failed = marked.find(gate => gate.status !== "pass" || gate.exit !== 0);
    const gate = failed ?? marked.find(gate => gate.status === "pass" && gate.exit === 0);
    if (!gate) continue;
    const definition = task.gates.find(definition => definition.id === gate.id);
    (invocation.originalProblem ??= {})[criterion] = { status: failed ? "failed" : "passed", loop: loop.number,
      taskId: task.id, attempt: descriptor.number, candidate: candidate(receipt.after),
      check: { id: gate.id, command: definition.command, cwd: definition.cwd },
      ref: descriptor.gate?.ref ? clone(descriptor.gate.ref) : null };
  }
}
function originalProblem() {
  const anchor = config.originalProblem;
  if (text(anchor?.spec)) return { status: "unknown", reason: `Original problem is verified by spec ${anchor.spec}.` };
  if (!Array.isArray(anchor?.criteria)) return { status: "unknown", reason: "Spec has no original-problem anchor." };
  const criteria = anchor.criteria.map(criterion => {
    const recorded = invocation?.originalProblem?.[criterion];
    return { criterion, ...clone(recorded && same(recorded.candidate, currentCandidate) ? recorded : { status: "not-run" }) };
  });
  const pick = status => criteria.filter(item => item.status === status).map(item => `#${item.criterion}`).join(", ");
  return criteria.some(item => item.status === "failed") ? { status: "unfulfilled", criteria,
      reason: `Designated original-problem checks failed for ${pick("failed")}.` }
    : criteria.every(item => item.status === "passed") ? { status: "fulfilled", criteria,
      reason: "Designated original-problem checks passed on their recorded candidates; advisory, not whole-spec compliance." }
    : { status: "unknown", criteria, reason: `Original-problem criteria not yet verified: ${pick("not-run")}.` };
}
function cancelledScope() { return Object.values(invocation?.excludedScope ?? {}); }
function unfulfilledCancellations() { return cancelledScope().filter(task => !task.completed); }
function progress() {
  emitTodoSnapshot();
  const value = {
    type: "execution-progress", invocation: config.invocation, loop: loop?.number ?? 0,
    loopsConsumed: invocation?.consumedLoops ?? 0, maxLoops: maxCycles(),
    label: `Loop ${loop?.number ?? 0} de ${maxCycles()}`, phase: loop?.phase ?? "admission",
    ...(loop?.attempt ? { taskId: loop.attempt.taskId, attempt: loop.attempt.number } : {}),
    boardTopicId: invocation?.boardTopicId ?? null,
    elapsedMs: invocation ? Date.now() - invocation.startedAt : null, tokens: metrics(),
    action: action("gaps", "Next existing operation; no new dispatch claimed by this progress event."),
  };
  if (typeof emit === "function") emit(value);
  return value;
}
function metrics(selectedLoop) {
  const values = (selectedLoop ? [selectedLoop] : [loop]).flatMap(item => item?.usage ?? []);
  const totals = selectedLoop ? selectedLoop.usageSummary ?? { tokens: 0, known: 0, unknown: 0 } : invocation?.usageTotals ?? { tokens: 0, known: 0, unknown: 0 };
  const known = totals.known + values.filter(item => item.tokens !== null).length;
  const unknown = totals.unknown + values.filter(item => item.tokens === null).length;
  return { value: known ? totals.tokens + values.reduce((sum, item) => sum + (item.tokens ?? 0), 0) : null,
    coverage: !known ? "unavailable" : unknown ? "partial" : "reported" };
}
function foldUsage() {
  loop.usageSummary = { tokens: 0, known: 0, unknown: 0 };
  for (const value of loop.usage) {
    if (value.tokens === null) { invocation.usageTotals.unknown++; loop.usageSummary.unknown++; }
    else { invocation.usageTotals.known++; invocation.usageTotals.tokens += value.tokens; loop.usageSummary.known++; loop.usageSummary.tokens += value.tokens; }
  }
  loop.usage = [];
}
function usage(result, childKey) {
  if (!loop) return;
  // SingleResult.usage is reported by the runtime. Count each producer once,
  // including replay. Never sum both aggregate and per-child usage.
  const entries = result?.results?.length ? result.results : [null];
  entries.forEach((entry, index) => {
    const id = `${result?.runId ?? childKey}:${index}`;
    if (loop.usage.some(value => value.id === id)) return;
    const reported = entry?.usage;
    const fields = ["input", "output", "cacheRead", "cacheWrite"];
    const tokens = reported && fields.every(field => Number.isFinite(reported[field]) && reported[field] >= 0)
      ? fields.reduce((total, field) => total + reported[field], 0) : null;
    loop.usage.push({ id, tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : null });
  });
}
function projection(childKey, result) {
  const statuses = ["complete", "continue", "gaps", "blocked",
    "fulfilled", "recovered", "lost", "conflict", "unresolved"];
  return {
    ref: nativeReference(childKey, result), ok: result?.ok === true,
    status: statuses.includes(result?.structuredOutput?.status) ? result.structuredOutput.status : "unavailable",
    barrier: barrier(result), reused: result?.reused === true,
    terminal: result?.terminalOutcome ? {
      state: ["partial", "failed", "completed", "stopped"].includes(result.terminalOutcome.state)
        ? result.terminalOutcome.state : "unknown",
      reason: ["timeout", "budget_exhausted", "stopped", "cancelled"].includes(result.terminalOutcome.reason)
        ? result.terminalOutcome.reason : "native-terminal",
    } : null,
  };
}
// Analysis keys are launch identities, not a read-only reattachment API.
// Keep compact intentions/receipts; replay must observe the exact native producer.
const analysisResults = new Map();
function analysisStep(childKey) {
  if (childKey.includes(".review.")) return "final-review";
  if (/\.task-reviewer$/.test(childKey)) return "task-reviewer";
  if (/\.task-synthesis$/.test(childKey)) return "task-synthesis";
  if (childKey.endsWith(".demand-observation")) return "demand-observation";
  return "compliance";
}
function generationKey(base, step) {
  const generation = loop.analysisGenerations?.[step.startsWith("task-") ? `${base}.${step}` : step] ?? 1;
  return generation === 1 ? base : `${base}.g${generation}`;
}
function reviewPrefix(generation = loop.analysisGenerations?.["final-review"] ?? 1, number = loop.number) {
  if (generation === 1) return `${key}.l${number}.review.`;
  const suffix = `.l${number}.g${generation}.review.`;
  const base = key.length + suffix.length <= 83 ? key
    : `${key.slice(0, 83 - suffix.length - 13)}-${canonicalDigest(key).slice(0, 12)}`;
  return `${base}${suffix}`;
}
function demandKey() {
  return `${generationKey(`${key}.l${loop.number}`, "demand-observation")}.demand-observation`;
}
function finalReviewRequest(cursor) {
  const { invocation, epoch, root, storeId, action, review, timeouts } = cursor;
  const base = `${key}.l${cursor.loop.number}`;
  const originals = review.slots.filter(slot => slot.key !== action.key)
    .map(({ key, runId, digest }) => ({ key, runId, digest }));
  // The last native result may have settled before reviewPhase remembered it.
  // The writer binds that original through the journal on both paths.
  originals.push({ key: action.key, runId: action.runId });
  return { operation: "reviewOriginals", root, invocation, key: `${base}.reviewOriginals`,
    storeId, scope: `exec:${invocation}.e${epoch}`, expectedHead: { seq: action.input.seq, hash: action.input.digest },
    refs: { input: { seq: action.input.seq, digest: action.input.digest }, originals, reviewerMs: timeouts.reviewerMs } };
}
function admitFinalReview(receipt, request, target, observedAgent) {
  const seed = receipt.P?.prompt.closingSeed;
  if (receipt.storeId !== request.storeId || !same(seed?.input, request.refs.input) ||
      !same(seed.body.integratedReview.originals.map(({ key, runId }) => ({ key, runId })),
        request.refs.originals.map(({ key, runId }) => ({ key, runId }))) ||
      request.refs.originals.some(ref => ref.digest && seed.digests[ref.key] !== ref.digest))
    throw new Error("Final review publication receipt integrity mismatch.");
  const synthesis = seed.body.integratedReview.originals.at(-1);
  if (observedAgent !== undefined && !seed.body.review.references.some(ref =>
      ref.key === synthesis.key && ref.runId === synthesis.runId && ref.agent === observedAgent))
    throw new Error("Final review replay producer integrity mismatch.");
  Object.assign(target, {
    candidate: candidate(seed.body.candidate),
    closingSeed: seed, review: seed.body.review, integratedReview: seed.body.integratedReview,
    reviewSynthesis: { key: synthesis.key, path: synthesis.path, sha256: synthesis.sha256 },
    closingPublication: { invocation: request.invocation, storeId: request.storeId,
      input: { seq: seed.input.seq, digest: seed.input.digest }, compliance: null },
    usage: clone(seed.body.usage), analysisCalls: clone(seed.body.analysisCalls),
  });
  delete receipt.P.prompt.closingSeed;
}
function compactIntegratedReview() {
  const retained = loop.integratedReview;
  if (retained?.decision?.reference?.loop !== loop.number || loop.closingSeed || loop.archived) return Promise.resolve();
  const request = finalReviewRequest(executeCursor());
  return loopIO("reviewOriginals", request).then(receipt => admitFinalReview(receipt, request, loop));
}
function analysisBarrier(result, ref) {
  return barrier(result, ref) ?? [result, ...(result?.results ?? [])].filter(Boolean)
    .map(item => barrier(item) ??
      (item.state === "cancelled" || ["stopped", "cancelled"].includes(item.terminalOutcome?.reason) ? "stopped" :
        item.toolBudgetBlocked || item.acceptance?.recovery || item.terminalOutcome?.reason === "budget_exhausted"
          ? "native child barrier" : null))
    .find(Boolean) ?? null;
}
function nativeTimeout(result) {
  const entries = [result, ...(result?.results ?? [])].filter(Boolean);
  return !analysisBarrier(result) &&
    (result?.results?.some(item => item.timedOut === true) ||
      entries.some(item => item.terminalOutcome?.reason === "timeout"));
}
function terminalAnalysis(result, ref) {
  if (analysisBarrier(result, ref.runId ?? ref.key)) return false;
  return ["complete", "completed", "failed"].includes(result?.state) ||
    analysisSettled(result, ref) || managementAnalysisState(result, ref) === "failed" ||
    closedProducerProcesses(result);
}
function analysisTimeoutHalt(call, result, generation) {
  const step = analysisStep(call.key);
  return { code: "timeout", status: "partial", class: step, key: call.key,
    launchedMs: call.timeoutMs, ref: clone(nativeReference(call.key, result, true)),
    reason: `${step} ${call.key} timed out at ${call.timeoutMs} ms. ${generation >= 3
      ? "The three-generation limit is reached; use a new invocation."
      : `Relaunch with args.timeouts.reviewerMs strictly greater than ${call.timeoutMs}.`}` };
}
function haltAnalysisTimeout(call, result) {
  if (!nativeTimeout(result)) return Promise.resolve();
  const step = analysisStep(call.key);
  const slot = step.startsWith("task-") ? `${loop.attempt.key}.${step}` : step;
  const halt = analysisTimeoutHalt(call, result, loop.analysisGenerations?.[slot] ?? 1);
  call.timeout = true;
  call.ref = clone(halt.ref);
  loop.halt ??= halt;
  return save().then(() => { throw new Error(loop.halt.reason); });
}
function renewAnalysisTimeout(cursor) {
  const halt = loop?.halt;
  if (halt?.code !== "timeout" || !["task-reviewer", "task-synthesis", "demand-observation", "compliance", "final-review"].includes(halt.class))
    return;
  if (effectiveTimeouts().reviewerMs <= halt.launchedMs) return;
  const step = halt.class;
  const slot = step.startsWith("task-") ? `${loop.attempt.key}.${step}` : step;
  const generation = loop.analysisGenerations?.[slot] ?? 1;
  if (generation >= 3) {
    halt.reason = `${step} reached the three-generation limit; use a new invocation.`;
    return save();
  }
  const call = loop.analysisCalls?.find(call => call.key === halt.key);
  if (!call?.timeout || !nativeTimeout(halt.ref)) return;
  const replayedReviewer = cursor?.halt?.stage === "timeout" && reviewerTimeoutAction(cursor.action) &&
    cursor.action.key === halt.key && cursor.halt.digest === canonicalDigest(halt);
  // Re-observe exact producers, including settled siblings of a whole review phase.
  const retiring = step === "final-review"
    ? loop.analysisCalls.filter(call => call.key.includes(".review.")) : [call];
  const retiredRefs = new Map();
  let settled = true;
  return retiring.reduce((previous, entry) => previous.then(() => {
    let ref = loop.review?.references?.find(ref => ref.key === entry.key) ?? entry.ref;
    if (!text(ref.runId) && entry.stage === "intention" && step !== "final-review")
      ref = config.recovery?.references?.find(ref => ref.key === entry.key) ?? ref;
    // Only the exact native admission rejection proves a sibling never started.
    if (!text(ref.runId) && budgetRejected(entry.key)) {
      retiredRefs.set(entry.key, ref);
      return;
    }
    if (!text(ref.runId)) { settled = false; return; }
    const status = replayedReviewer ? observeReviewerTimeoutStatus(ref.runId) : observeStatus(ref.runId, true);
    return status.then(observed => {
      if (replayedReviewer) checkReviewerTimeoutIdentity(observed, ref);
      const cause = analysisBarrier(observed, ref.runId ?? ref.key);
      if (cause) throw nativeBarrier(cause, ref);
      if (!text(ref.runId) || observed?.runId !== ref.runId && !managementAnalysisState(observed, ref) ||
          observed?.agent && ref.agent && observed.agent !== ref.agent ||
          observed?.key && ![ref.key, ref.runId].includes(observed.key) ||
          !terminalAnalysis(observed, ref)) settled = false;
      retiredRefs.set(entry.key, ref);
    });
  }), Promise.resolve()).then(() => {
    if (!settled) {
      halt.reason = `${step} timeout renewal requires exact terminal, barrier-free producer evidence for every retiring step; reconcile the retained producers. No replacement dispatched.`;
      return;
    }
    const rejectedKeys = invocation.budgetRejectedKeys;
    (loop.retired ??= []).push(...retiring.map(entry =>
      clone(entry.key === halt.key ? halt.ref : retiredRefs.get(entry.key))));
    loop.analysisCalls = loop.analysisCalls.filter(entry => !retiring.includes(entry));
    if (rejectedKeys)
      invocation.budgetRejectedKeys = rejectedKeys.filter(digest => !retiring.some(entry => canonicalDigest(entry.key) === digest));
    (loop.analysisGenerations ??= {})[slot] = generation + 1;
    if (step === "final-review") {
      delete loop.review; delete loop.reviewSynthesis; delete loop.reviewOriginals; delete loop.integratedReview;
    }
    if (step === "compliance") delete loop.compliance;
    delete loop.halt;
    delete loop.outcome;
    retiringAnalysis = step === "final-review" ? reviewPrefix() :
      `${halt.key.replace(new RegExp(`(?:\\.g[23])?\\.${step}$`), "")}.g${generation + 1}.${step}`;
  }).catch(error => {
    // This pre-budget observation precedes admissionValidated; retain current
    // Stop/denial evidence here rather than relying on the general catch below.
    if (!error?.nativeBarrier || persistenceFailed) throw error;
    if (replayedReviewer && reviewerRenewalCauses.includes(error.nativeBarrier))
      return holdReviewerRenewal(cursor, halt, error.nativeBarrier);
    loop.halt = { code: "native-barrier",
      status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
      cause: error.nativeBarrier, reason: String(error.message),
      ref: clone(error.nativeReference ?? halt.ref) };
    return save().then(() => { throw error; });
  });
}
function managementAnalysisState(observed, ref) {
  let lines = typeof observed?.output === "string" ? observed.output.split(/\r?\n/) : [];
  if (lines[0] === `Status target: run ${ref.runId ?? ref.key}` &&
      /^Spawn budget:/.test(lines[1] ?? "") && /^Active async capacity:/.test(lines[2] ?? ""))
    lines = lines.slice(3);
  if (observed?.ok &&
      (lines[0] === `Run: ${ref.runId ?? ref.key}` || lines[0] === `Nested run: ${ref.runId ?? ref.key}`))
    return lines.find(line => line.startsWith("State: "))?.slice(7);
}
function analysisSettled(observed, ref) {
  // Failed management status proves retirement, never successful original admission.
  return observed?.ok && (observed.state === "complete" || managementAnalysisState(observed, ref) === "complete");
}
function retainedReadOnlyOriginal(observed, ref, originals = inspectedAnalyses) {
  // Management status is not the original. Prefer its complete native body;
  // only fall back to the exact associated original read by the inspector.
  const original = originals.find(value => value.key === ref.key && value.runId === ref.runId);
  const retainedBarrier = barrier(original, ref.runId ?? ref.key);
  if (retainedBarrier) throw nativeBarrier(retainedBarrier);
  if (original?.error && original.error !== "Complete retained analysis original unavailable.")
    throw new Error(original.error);
  if (observed?.agent && original?.agent && observed.agent !== original.agent)
    throw new Error("Conflicting retained analysis producer agents.");
  if (observed?.structuredOutput && original?.ok && !same(observed.structuredOutput, original.structuredOutput))
    throw new Error("Conflicting complete retained analysis originals.");
  if (!observed?.structuredOutput && original) {
    if (!original.ok) throw new Error(original.error ?? `Complete retained read-only original unavailable for ${ref.runId ?? ref.key}.`);
    if (original.state !== "complete" && !analysisSettled(observed, ref))
      throw new Error(`Read-only producer settlement uncertain for ${ref.runId ?? ref.key}; no replacement dispatched.`);
    observed = { ...ref, ...original, reused: true };
  }
  return observed;
}
function observeAnalysis(call, verifiedTaskOriginal) {
  const ref = call.ref.runId ?? call.key;
  return observeStatus(ref).then(observed => {
    if (call.ref.runId && observed?.runId && call.ref.runId !== observed.runId)
      throw new Error("Analysis producer/run identity conflicts with retained receipt.");
    const cause = analysisBarrier(observed, ref);
    if (cause) throw nativeBarrier(cause, call.ref);
    if (nativeTimeout(observed)) return haltAnalysisTimeout(call, observed);
    const taskOriginal = Object.values(loop.attempt?.taskReview ?? {}).find(ref => ref?.key === call.key && ref.digest);
    const publishedRef = taskOriginal ?? loop.review?.references?.find(ref => ref.key === call.key);
    const originalRef = publishedRef ?? call.ref;
    if (publishedRef && publishedRef.runId !== call.ref.runId)
      throw new Error("Retained review publication producer conflicts with analysis identity.");
    observed = retainedReadOnlyOriginal(observed, originalRef);
    if (taskOriginal && observed?.structuredOutput &&
        canonicalDigest(clone(observed.structuredOutput)) !== taskOriginal.digest)
      throw new Error(`Task review original integrity conflict with admitted digest: ${call.key}.`);
    if (call.key.includes(".review.") && observed?.structuredOutput && observed.runId === originalRef.runId) {
      // Exact narrow recovery delivers the body, not new publication. Retain the
      // original launch's witnesses without treating structuredOutputPath as one.
      const publicationFields = ["asyncDir", "outputReference", "outputArtifactPath", "outputPathMapping", "outputSaveError", "metadataSaveError", "artifactPaths"];
      const publication = Object.fromEntries(publicationFields.filter(field => originalRef[field] !== undefined).map(field => [field, originalRef[field]]));
      observed = { ...publication, ...observed, results: (observed.results?.length ? observed.results : originalRef.results ?? []).map((entry, index) => ({
        ...Object.fromEntries(Object.entries(originalRef.results?.find(item => (item.index ?? index) === (entry.index ?? index)) ?? {})
          .filter(([field]) => !["exitCode", "interrupted", "timedOut"].includes(field))),
        ...Object.fromEntries(Object.entries(entry).filter(([field]) => observed.results?.length || !["exitCode", "interrupted", "timedOut"].includes(field))),
      })) };
    }
    // Only reviewTask's fresh disk/digest check permits using the saved projection.
    const verifiedProjection = verifiedTaskOriginal === taskOriginal && taskOriginal && reviewProjection(taskOriginal) &&
      observed?.runId === taskOriginal.runId && analysisSettled(observed, originalRef);
    if (!observed?.ok || !text(observed.runId) || !observed.structuredOutput && !verifiedProjection) {
      if (call.barrier) throw nativeBarrier(call.barrier);
      throw new Error(`Complete retained analysis unavailable for ${ref}; no replacement dispatched.`);
    }
    analysisResults.set(call.key, observed);
    return observed;
  });
}
function closedProducerProcesses(result) {
  // Native SingleResult reports a nonzero exit code or processSignal on
  // process closure. Its partial terminalOutcome is not a settlement receipt.
  return Array.isArray(result?.results) && result.results.length > 0 &&
    result.results.every(item => !item.detached && Number.isInteger(item.exitCode) &&
      (item.exitCode > 0 || text(item.processSignal)));
}
function reconcileAnalysis() {
  // Older retained phase receipts already identify producers; missing intention
  // metadata never licenses relaunching them.
  const hasIntentions = !!loop.analysisCalls?.length;
  const calls = [...(loop.analysisCalls ?? [])].filter(call => call.key !== demandKey());
  for (const ref of [...(loop.review?.references ?? []), loop.compliance?.ref].filter(Boolean)) {
    if (!calls.some(call => call.key === ref.key))
      calls.push({ key: ref.key, stage: "receipt", ref: { key: ref.key, ...(text(ref.runId) ? { runId: ref.runId } : {}) },
        barrier: ref.barrier ?? barrier(ref) });
  }
  if (!hasIntentions && loop.halt?.code === "native-barrier" && !calls.some(call => call.barrier))
    return Promise.reject(nativeBarrier(loop.halt.cause ?? "analysis receipt unavailable; settlement uncertain"));
  loop.analysisCalls = [...(loop.analysisCalls ?? []).filter(call => call.key === demandKey()), ...calls];
  // Observe the whole retained group before a missing sibling may be launched.
  return calls.reduce((settled, call) =>
    settled.then(() => budgetRejected(call.key) ? undefined : analysisResults.get(call.key) ?? observeAnalysis(call)), Promise.resolve()).then(() => {
      if (loop.analysisCalls?.length && loop.halt?.code === "native-barrier") delete loop.halt;
    });
}
// A pending v6 task must retain its selected identity and checkpoint intention.
function pendingCheckpointUnit() {
  return loop?.phase === "implementation" && loop.attempt?.checkpoint && !loop.attempt.result &&
    selectedTasks()[loop.cursor]?.id === loop.attempt.taskId;
}
const REVIEWER_TIMEOUT_MS = 14400000;
function effectiveTimeouts() {
  const values = invocation?.timeouts?.values ?? {};
  return { reviewerMs: values.reviewerMs ?? REVIEWER_TIMEOUT_MS,
    workerMs: values.workerMs ?? 14400000, gateFloorMs: values.gateFloorMs ?? 0 };
}
function timeoutReport() {
  return { values: effectiveTimeouts(), since: invocation?.timeouts?.since ?? null };
}
function updateTimeouts() {
  if (config.timeouts === undefined) return Promise.resolve();
  const values = Object.keys(config.timeouts).length
    ? { ...(invocation.timeouts?.values ?? {}), ...config.timeouts } : {};
  if (invocation.timeouts && same(values, invocation.timeouts.values)) return Promise.resolve();
  invocation.timeouts = { values: clone(values),
    since: { loop: loop?.number ?? 0, attempt: loop?.attempt?.number ?? 0 } };
  return save();
}
function effectiveGates(gates) {
  return gates.map(gate => ({ ...gate,
    timeoutMs: Math.max(gate.timeoutMs ?? 1800000, effectiveTimeouts().gateFloorMs) }));
}
function gateTaskFor(task) {
  return { id: task.id, gates: effectiveGates(task.gates ?? task.checks.map(check => ({
    id: check.id, command: check.command, cwd: check.cwd, timeoutMs: check.timeoutMs ?? 1800000 }))),
    metric: task.metric ?? null, progress: clone(loop.metricSeries ?? task.progress ?? { nonImproving: 0, last5: [] }) };
}
function gateOperationTimeout(task) {
  return Math.min(2147483647, Math.max(14400000,
    task.gates.reduce((sum, gate) => sum + (gate.timeoutMs ?? 1800000), 0) +
      (task.metric ? 1800000 : 0) + 3600000));
}
function gateTimeoutHalt(descriptor, step, launchedMs, result, closingLoop = loop) {
  const pending = descriptor.gate;
  // The sandbox can omit result paths and normalize the artifact inventory.
  // Bind the halt to the producer identity and timeout controls present in both views.
  const { key, runId, agent } = pending.ref;
  const ref = { key, runId, agent };
  if (result) {
    if (result.terminalOutcome) ref.terminalOutcome = clone(result.terminalOutcome);
    ref.results = (result.results ?? []).map(entry => Object.fromEntries(
      ["timedOut", "terminalOutcome", "exitCode", "state"]
        .filter(field => entry[field] !== undefined).map(field => [field, entry[field]])));
  }
  return { code: "timeout", status: "partial", class: step,
    key: ref.key, launchedMs, ref,
    reason: `${step} ${ref.key} timed out at ${launchedMs} ms.${step === "final-acceptance"
      ? ` ${acceptanceResults(closingLoop).blocking.filter(gate => gate.status === "timeout").map(gate => `${gate.id}: ${gate.logRef}`).join("; ")}.` : ""} ${(descriptor.gateGeneration ?? 1) >= 3
      ? "The three-generation limit is reached; use a new invocation."
      : `Relaunch with args.timeouts.gateFloorMs strictly greater than ${launchedMs}.`}` };
}
function haltGateTimeout(descriptor, step, launchedMs, result) {
  descriptor.gate.timeout = true;
  loop.halt = gateTimeoutHalt(descriptor, step, launchedMs, result);
  // Bind the actual deadline independently of higher options saved on relaunch.
  dispatchedAction.gateTimeoutMs = launchedMs;
  const ref = loop.halt.ref;
  if (text(ref.runId)) inFlight.set(ref.key, { key: ref.key, runId: ref.runId, role: "loop-io" });
  return save();
}
function renewGateTimeout() {
  const halt = loop?.halt;
  if (halt?.code !== "timeout" || !["gate-transport", "final-acceptance"].includes(halt.class)) return;
  const descriptor = halt.class === "final-acceptance" ? loop.finalAttempt
    : [loop.attempt, loop.finalAttempt].find(value => value?.gate?.ref?.key === halt.key);
  const pending = descriptor?.gate;
  if (!pending?.timeout || pending.ref?.key !== halt.key) return;
  const task = descriptor === loop.finalAttempt
    ? { id: "final-acceptance", gates: loop.acceptance, metric: null } : loop.task;
  const freshTask = gateTaskFor(task);
  const raised = halt.class === "gate-transport" ? effectiveTimeouts().gateFloorMs > halt.launchedMs &&
    gateOperationTimeout(freshTask) > halt.launchedMs
    : effectiveTimeouts().gateFloorMs > halt.launchedMs;
  if (!raised) return;
  const generation = descriptor.gateGeneration ?? 1;
  if (generation >= 3) {
    halt.reason = `${halt.class} reached the three-generation limit; use a new invocation.`;
    return save();
  }
  (loop.retired ??= []).push(clone(halt.ref));
  descriptor.gateGeneration = generation + 1;
  inFlight.delete(halt.ref.key);
  descriptor.gate = { key: `${descriptor.key}.g${generation + 1}.gate`, stage: "intention",
    retry: 0, task: freshTask };
  delete loop.halt;
  delete loop.outcome;
}
function analysisDispatch(requests) {
  return Promise.allSettled(requests.map(request => Promise.resolve().then(() => {
    loop.analysisCalls ??= [];
    let call = loop.analysisCalls.find(entry => entry.key === request.key);
    if (call && !budgetRejected(call.key)) return analysisResults.get(call.key) ?? observeAnalysis(call);
    if (!call) {
      call = { key: request.key, stage: "intention", ref: { key: request.key },
        timeoutMs: request.key === retainedAnalysisDeadline?.key
          ? retainedAnalysisDeadline.ms : effectiveTimeouts().reviewerMs };
      loop.analysisCalls.push(call);
    }
    const checkMissing = loop.replayedEarlyReview && request.key.includes(".review.")
      && !budgetRejected(request.key) ? observeStatus(request.key, true).then(observed => {
        const cause = analysisBarrier(observed, request.key);
        if (cause) throw nativeBarrier(cause, { key: request.key, runId: observed.runId });
        if (observed?.runId || observed?.state && observed.state !== "unknown" ||
            observed?.state === "unknown" && !String(observed.output).endsWith("Run not found. Provide id or runId."))
          throw new Error(`Review re-entry lacks an exact original for ${request.key}; no replacement dispatched.`);
      }) : Promise.resolve();
    return checkMissing.then(() => save()).then(() => {
      if (persistenceFailed) throw new Error(persistenceReason);
      return dispatch([{ ...request, timeoutMs: call.timeoutMs }]);
    }).then(([result]) => {
      call.stage = "receipt";
      call.ref = request.key.includes(".review.") || /\.task-(reviewer|synthesis)$/.test(request.key) || request.key === demandKey()
        ? nativeReference(request.key, result)
        : { key: request.key, ...(text(result?.runId) ? { runId: result.runId } : {}) };
      call.barrier = analysisBarrier(result);
      // The first receipt must retain timeout evidence even if management status cannot replay it.
      if (!call.barrier && nativeTimeout(result)) return haltAnalysisTimeout(call, result);
      const failure = () => {
        const error = nativeBarrier(call.barrier, { ...call.ref, agent: result.agent }, result);
        if (call.barrier === "native permission denial" && !call.ref.runId)
          error.nativeDispatch = { key: call.key, role: "reviewer" };
        return error;
      };
      return save().then(() => {
        if (call.barrier) throw failure();
        analysisResults.set(call.key, result);
        return result;
      }, error => {
        if (call.barrier) throw failure();
        throw error;
      });
    }, error => {
      if (persistenceFailed) throw error;
      call.stage = "receipt";
      call.barrier = error?.nativeBarrier ?? null;
      if (error?.nativeBarrier && /\.task-(reviewer|synthesis)$/.test(request.key))
        error.nativeReference ??= clone(call.ref);
      return save().then(() => { throw error; });
    });
  }))).then(settled => {
    // Settle sibling receipt saves before the root persists an exhaustion/barrier.
    const failure = settled.find(item => item.status === "rejected" && item.reason?.nativeBarrier) ??
      settled.find(item => item.status === "rejected" && !item.reason?.spawnBudgetExhausted) ??
      settled.find(item => item.status === "rejected");
    if (failure) throw failure.reason;
    return settled.map(item => item.value);
  });
}
function collect(childKey, agent, display, task, outputSchema, implementation = false, dispatcher = dispatch, resume, demandObservation = false) {
  const label = display.label.replace(/\s+/g, " ").trim().slice(0, 120);
  progress();
  const scopeDiscipline = ["pitako.execution-director", "pitako.worker"].includes(agent) || demandObservation;
  return dispatcher([{
    key: childKey, ...(resume ? { resume } : { agent, context: "fresh" }), label, phase: display.phase, cwd: config.root,
    // Reviewer roles take the frozen first review model; no agent override decides it.
    ...(!resume && pitakoAgentFamily(agent) === "reviewer" ? { model: invocation.reviewModels.r1.model } : {}),
    output: `${childKey}.json`, outputMode: "file-only", reads: false, progress: false,
    skill: [...new Set([
      "verify-behavior", "ponytail",
      ...(agent === "pitako.worker" ? ["rust-best-practices", "rust-review", "rust-port"] : []),
      ...(pitakoAgentFamily(agent) === "reviewer" ? ["ponytail-review", "rust-best-practices", "rust-review"] : []),
      ...(scopeDiscipline ? ["scope-discipline"] : []),
    ])],
    task: `${label}\n\n${scopeDiscipline ? "Read and apply scope-discipline before expanding work or verification; preserve admitted tasks and gates.\n" : ""}${task}`, outputSchema,
    // Keep awaited final-result admission; live steps reach the main session from the child session file.
    ...(implementation ? { timeoutMs: loop.attempt.timeoutMs,
      ...(!resume ? { extensionBindings: { "pitako.checkpoint/1": { association: clone(invocation.association), key: loop.attempt.key } } } : {}),
      acceptance: {
      level: "none", reason: "Execute root owns mandatory checks, shared adversarial review and whole-spec compliance; avoid duplicate inferred gates.",
    } } : {}),
  }]).then(([result]) => {
    references.push(nativeReference(childKey, result));
    usage(result, childKey);
    if (result?.nativeFailure && !barrier(result)) {
      const error = new Error(result.nativeFailure.reason);
      error.nativeFailure = result.nativeFailure;
      throw error;
    }
    return result;
  });
}
function association(number) {
  return { ...invocation.association, loop: number };
}
function planConflict(reason, result) {
  const { key, runId } = loop.plan.ref;
  loop.halt = result && runId && result.agent === "pitako.execution-director"
    ? { status: "blocked", code: "plan-conflict", reason, ref: { key, runId },
        originalDigest: canonicalDigest(clone({ value: result.structuredOutput, output: result.output })) }
    : { status: "blocked", code: "semantic-block", reason, ref: clone(loop.plan.ref) };
  throw new Error(reason);
}
function planAuthority(value, result) {
  const reason = planConflictReason(value, result, loop.plan.ref.runId, same);
  if (reason) planConflict(reason, result);
}
function validatePlan(value) {
  if (!value || !(value.select === null || text(value.select)) || !Array.isArray(value.changes) || !text(value.reason))
    throw new Error("Invalid backlog selection: select, changes and reason required.");
  return value;
}
function sharedContext() {
  return { material: "Use the immutable spec, selected backlog task and current Board view. Authority: spec, frozen amendments and current HUMAN rulings (most recent human source wins; cite it) > DECISION > FINDING > HANDOFF; code wins over any map.",
    references: [invocation.association.source, invocation.backlogPath].filter(text) };
}
function selectedTasks() {
  if (!loop?.task) return [];
  const task = loop.task;
  return [{ ...task, kind: "implementation", sourceRefs: task.specRefs,
    checks: task.gates.map(gate => ({ ...gate, requirement: task.expectedResult, tier: "focused" })),
    dependsOn: task.dependsOn.map(taskId => ({ taskId, reason: "Backlog prerequisite, validated done by apply" })) }];
}
function prerequisiteResults(task) {
  return task.dependsOn.map(dependency => ({ taskId: dependency.taskId, status: "done", source: invocation.backlogPath }));
}
function backlogAuthority() {
  return { specDigest: invocation.association.digest, amendmentDigests: (invocation.amendments ?? []).map(item => item.sha256) };
}
const LOOP_IO_CONTROL = { needsAttentionAfterMs: 1_800_000 };
function loopIORequest(childKey, input, timeoutMs) {
  return { key: childKey, agent: pitakoLoopAgent(input.operation), cwd: config.root, context: "fresh", output: false,
    outputMode: "inline", outputSchema: false, reads: false, progress: false,
    control: LOOP_IO_CONTROL, ...(["close", "gate"].includes(input.operation) &&
      (input.gate || timeoutMs !== undefined) ? { timeoutMs: timeoutMs ?? gateOperationTimeout(input.gate.task) } : {}),
    task: ["close", "baseline", "taskDelta", "drain"].includes(input.operation) && !input.refs
      ? canonicalJSON(input) : JSON.stringify(input) };
}
function terminalLoopIOResult(result, childKey, operation) {
  return result.ok && pitakoAgentFamily(result.agent) === "loop-io" && text(result.runId) &&
    (result.key === undefined || result.key === childKey) && result.state === undefined && !result.terminalOutcome &&
    (!["advance", "selection", "close", "drain"].includes(operation) ||
      text(result.asyncDir) && text(result.externalAdapter?.outputArtifacts?.stdoutPath) &&
      text(result.externalAdapter?.outputArtifacts?.stderrPath)) &&
    ![result, ...(result.results ?? [])].some(item => item.error || item.outputSaveError || item.metadataSaveError ||
      item.transcriptError || item.outputPartial || item.truncation || item.timedOut || item.processSignal) &&
    Array.isArray(result.results) && result.results.length === 1 && result.results[0].exitCode === 0;
}
function queueIntention(intention) {
  const pending = invocation.intentions ??= [];
  const existing = pending.find(entry => entry.key === intention.key);
  if (existing) {
    if (!same(existing, intention)) throw new Error(`Pending loop-io intention changed: ${intention.key}.`);
  } else pending.push(clone(intention));
}
// Ledger intentions keep identities for bytes the workflow rebuilds exactly: the
// admitted spec and a frozen loop archive. A grouped launch transports the full request.
function transportIntention(intention) {
  const { archive, ...value } = clone(intention);
  if (value.operation !== "ledger") return value;
  if (value.input.spec && value.input.spec.content === undefined) {
    if (config.preliminary.digest !== value.input.spec.digest)
      throw Object.assign(new Error("Spec digest mismatch requires reliable admitted source bytes."), { ledgerIntegrity: true });
    value.input.spec = { content: config.preliminary.content, digest: value.input.spec.digest };
  }
  if (archive) value.input.record = frozenLoopRecord(value.input.record.loop, archive);
  return value;
}
function queueApply(slot, input) {
  if (invocation.intentions?.some(entry => entry.key === input.key)) return;
  const previous = invocation.intentions?.findLast(entry => entry.operation === "apply");
  if (previous) { input.expectedDigestFrom = previous.key; delete input.expectedDigest; }
  queueIntention({ key: input.key, operation: "apply", slot, taskId: loop.task?.id ?? invocation.transitionReplay?.taskId,
    complete: slot === "settlement" && loopResults().at(-1)?.status === "complete", input });
}
function receiptReference(value) {
  const prefix = `${config.root}/.pi/subagents/execute/${config.invocation}/loop-io/`;
  if (!value || !text(value.path) || !value.path.startsWith(prefix) ||
      value.path.slice(prefix.length).split("/").some(part => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(value.digest ?? "")) throw new Error(`Invalid loop-io disk receipt reference: ${value?.path ?? "missing path"}.`);
  return { path: value.path, digest: value.digest };
}
function admitDrain(transport, intentions) {
  receiptReference(transport);
  const receipt = transport.projection;
  if (receipt?.invocation !== config.invocation || !Array.isArray(receipt.steps) ||
      receipt.steps.length !== intentions.length) throw new Error("Invalid loop-io drain projection.");
  for (let index = 0; index < intentions.length; index++) {
    const intention = intentions[index], step = receipt.steps[index], value = step.result;
    if (step.key !== intention.key || step.operation !== intention.operation)
      throw new Error("loop-io drain order differs from persisted intentions.");
    if (intention.operation === "ledger") {
      if (Object.keys(value ?? {}).sort().join(",") !== (intention.input.record.kind === "loop" ? "count,head,summaries" : "count,head") ||
          value?.count !== Math.max(1, invocation.ledger.count) + 1 || !/^[a-f0-9]{64}$/.test(value.head ?? ""))
        throw new Error("Invalid drained ledger anchor.");
      invocation.ledger = { count: value.count, head: value.head };
      if (intention.input.record.kind === "unit") compactSealedAttempts(intention.input.record.body);
      if (intention.input.record.kind === "loop") {
        if (!validSummaries(value.summaries)) throw new Error("Invalid drained loop summaries.");
        loop.archived = true; delete loop.archivePending; delete loop.archiveQueued;
        // A resumed drain closes the loop even if its interruption cleared the outcome.
        loop.outcome = value.summaries.at(-1).status;
        foldLoop(value.summaries);
      }
    } else {
      if (!/^[a-f0-9]{64}$/.test(value?.digest ?? "") || !Array.isArray(value.cancelledScope))
        throw new Error("Invalid drained apply projection.");
      invocation.backlogDigest = value.digest;
      const { view, completedTasks, ...projection } = value;
      loop[intention.slot] = { ...loop[intention.slot], stage: "receipt", receipt: projection };
      if (intention.slot === "settlement") admitSettlement(value, intention);
      invocation.excludedScope = Object.fromEntries(value.cancelledScope.map(task => [task.id, task]));
    }
  }
}
function groupedIO(slot, input, owner = loop) {
  if (slot === "finishDrain" && owner[slot]?.admitted && invocation.intentions?.length) {
    const generation = (owner[slot].generation ?? 0) + 1;
    owner[slot] = { key: `${key}.l${loop.number}.${slot}.v${generation}`, generation, retry: 0, stage: "intention" };
  }
  const pending = owner[slot] ??= { key: owner === loop || owner === invocation ? `${key}.l${loop.number}.${slot}` : `${owner.key}.${slot}`, retry: 0, stage: "intention" };
  pending.intentionCount ??= invocation.intentions?.length ?? 0;
  pending.input ??= input.refs ? clone(input) : { ...clone(input), root: config.root, invocation: config.invocation, key: pending.key,
    ...(slot === "finishDrain" ? { storeId: invocation.storeId,
      expectedHead: clone(loop.replayedDrainAnchor &&
        same(storeProjection.P.control.operation.input, loop.replayedDrainAnchor.input)
        ? loop.replayedDrainAnchor.head : invocation.head),
      ...(loop.outcome === "complete" || loop.outcome === "gaps" && invocation.consumedLoops >= maxCycles()
        ? { finalDrain: true } : {}) } : {}),
    ...(input.operation !== "drain" ? { requestObservation: invocation.requestObservation ?? 0 } : {}),
    receipts: invocation.receiptReference ? [clone(invocation.receiptReference)] : [],
    ...(input.operation !== "drain" ? { requests: { cursor: 0 } } : {}) };
  const names = pending.steps ?? (input.operation === "advance" ? ["drain", "prepare", "requests"]
    : input.operation === "selection" ? ["drain", "apply", "requests", ...(pending.input.baseline ? ["baseline"] : [])]
    : input.operation === "close" ? ["drain", "requests", "gate", "seal", ...(pending.input.nextBaseline || pending.input.refs?.worker ? ["nextRequests", "nextBaseline"] : [])]
    : []);
  const intentions = pending.admitted ? [] : (invocation.intentions ?? []).slice(0, pending.intentionCount).map(transportIntention);
  return loopIO(slot, pending.input.refs ? pending.input : { ...pending.input, intentions }, owner).then(transport => {
    const reference = receiptReference(transport), projection = transport.projection;
    if (!projection || projection.invocation !== config.invocation || !Array.isArray(projection.steps) ||
        input.operation !== "drain" && projection.operation !== input.operation)
      throw new Error("Invalid grouped loop-io projection.");
    if (input.operation !== "drain") {
      if (!same(projection.steps.map(step => step.operation), names) ||
          projection.steps.some(step => step.key !== `${pending.key}.${step.operation}`))
        throw new Error("Grouped loop-io step order differs from its intention.");
    }
    if (!pending.admitted) {
      const before = clone(invocation);
      try {
        if (input.operation === "drain") admitDrain(transport, intentions);
        else {
          const drain = projection.steps[0];
          if (drain?.operation !== "drain" || drain.key !== `${pending.key}.drain`) throw new Error("Missing drain-first receipt.");
          admitDrain(drain.result, intentions);
        }
        invocation.intentions = (invocation.intentions ?? []).slice(pending.intentionCount);
        invocation.receiptReference = reference;
        pending.admitted = true;
      } catch (error) {
        invocation = before; loop = invocation.loop;
        throw error;
      }
      function persist(attempt = 1) {
        return save().then(() => {
          persistenceFailed = false; persistenceReason = null;
          return transport;
        }, error => {
          if (!error.terminalPersistence && attempt < 3) {
            persistenceFailed = false; persistenceReason = null;
            return persist(attempt + 1);
          }
          invocation = before; loop = invocation.loop;
          throw error;
        });
      }
      return persist();
    }
    return transport;
  });
}
function groupedStep(transport, operation) {
  const steps = transport.projection.steps.filter(step => step.operation === operation);
  if (steps.length !== 1) throw new Error(`Missing or duplicate grouped ${operation} receipt.`);
  return steps[0].result;
}
function observeGroupedRequests(transport, settling = false, page = groupedStep(transport, "requests")) {
  const reference = receiptReference(transport);
  if (!same(invocation.lastRequestReceipt, reference)) {
    invocation.requestObservation = (invocation.requestObservation ?? 0) + 1;
    invocation.lastRequestReceipt = reference;
  }
  return observeMainRequests(0, [], settling, page);
}
function checkpointIntent(taskId, number, attemptKey) {
  return { version: 2, association: clone(invocation.association), key: attemptKey,
    baseline: candidate(currentCandidate), taskId, attempt: number, loop: loop.number, cursor: loop.cursor,
    phase: "implementation", planRef: clone(loop.plan.ref),
    progress: { consumedLoops: invocation.consumedLoops,
      admitted: Object.fromEntries(Object.entries(invocation.tasks).filter(([, task]) => task.admitted.length)
        .map(([id, task]) => [id, clone(task.admitted)])),
      previous: invocation.lastConfirmed?.kind === "unit" ? (({ taskId, attempt, resultRef, checkpointRef, digest }) =>
        clone({ taskId, attempt, resultRef, checkpointRef, digest }))(invocation.lastConfirmed) : null } };
}
function committedIntentReference(reference, head) {
  if (!reference || Object.keys(reference).sort().join(",") !== "digest,seq" ||
      !Number.isSafeInteger(reference.seq) || reference.seq < 1 ||
      !/^[a-f0-9]{64}$/.test(reference.digest ?? "") ||
      !Number.isSafeInteger(head?.seq) || head.seq < reference.seq ||
      !/^[a-f0-9]{64}$/.test(head.hash ?? ""))
    throw Object.assign(new Error("Worker launch requires a committed intent at or before the store head."),
      { checkpointIntegrity: true });
  return clone(reference);
}
function admitBaseline(intent, receipt, head) {
  if (typeof receipt?.captured !== "boolean") throw new Error("Invalid grouped baseline receipt.");
  if (!receipt.captured) return null;
  const reference = committedIntentReference(receipt.intent, head);
  invocation.head = clone(head);
  return { checkpoint: { ...clone(intent), baseline: candidate(receipt.candidate) }, intent: reference };
}
function advanceLoop(slot = "advance", number = loop.number) {
  if (loop[slot]?.stage === "receipt" && !loop[slot].receipt?.projection) {
    // The admitted prepare is complete; resume any interrupted request/cancellation work.
    if (invocation.currentView) return observeMainRequests().then(() => save());
    // A new observation is not a replay of the completed immutable prepare.
    const generation = (loop[slot].generation ?? 0) + 1;
    loop[slot] = { key: `${key}.l${loop.number}.${slot}.v${generation}`, generation, retry: 0, stage: "intention" };
  }
  const complete = invocation.intentions?.findLast(entry => entry.slot === "settlement" && entry.complete);
  return groupedIO(slot, { operation: "advance",
    loopStartedAt: committedLoopOpen(number) ?? (number === loop.number ? loop.startedAt : Date.now()),
    candidate: candidate(currentCandidate),
    transition: { taskId: loop.task?.id ?? null, tasks: loop.task ? {
      [loop.task.id]: { completed: !!invocation.tasks[loop.task.id]?.completed,
        cancel: clone(invocation.tasks[loop.task.id]?.cancel ?? null) },
    } : {},
      requestObservation: invocation.requestObservation ?? 0 },
    demand: { sources: [
      ...(invocation.demandSources ?? []).filter(item => item.loop !== loop.number),
      { loop: loop.number, sources: loopDemandSources() },
    ], observations: invocation.demandObservations ?? [] },
    admission: { association: clone(invocation.association), admissionBinding: invocation.admissionBinding,
      amendments: clone(invocation.amendments ?? []), revivalContextPeak: invocation.revivalContextPeak,
      startedAt: invocation.startedAt, timeouts: clone(invocation.timeouts ?? null),
      models: { taskReviewer: invocation.taskReviewer, taskSynthesis: invocation.taskSynthesis,
        ...clone(invocation.reviewModels) } },
    prepare: { specId: config.id,
    previousConfirmedUnit: complete?.taskId ?? invocation.lastBacklogUnit ?? null, loop: number } }).then(transport => {
    const prepared = groupedStep(transport, "prepare");
    // The full grouped evidence is already published and admitted. Release it
    // before request observation can save the new view alongside the old loop.
    loop[slot].receipt = receiptReference(transport);
    delete loop[slot].input;
    const { view, ...prepareReceipt } = prepared;
    invocation.backlogPath = prepared.path; invocation.backlogDigest = prepared.digest;
    invocation.excludedScope = Object.fromEntries((prepared.cancelledScope ?? []).map(task => [task.id, task]));
    invocation.currentView = view; invocation.boardTopicId = view.topicId;
    invocation.loopSummaries = storeProjection.P.prompt.loopSummaries;
    invocation.demandSources = storeProjection.P.prompt.demand?.sources ?? [];
    invocation.demandObservations = storeProjection.P.prompt.demand?.observations ?? [];
    if (number === loop.number) loop.prepare = { stage: "receipt", receipt: clone(prepareReceipt) };
    else invocation.preparedNext = { stage: "receipt", receipt: clone(prepareReceipt) };
    return observeGroupedRequests(transport).then(() => save());
  });
}
// Runtime operations have durable intentions and fresh retry keys, like gate.
function loopIO(slot, input, owner = loop) {
  if (input.operation === "baseline" && !input.refs)
    input = { ...input, requestObservation: invocation.requestObservation ?? 0 };
  const pending = owner[slot] ??= { key: slot === "baselineIO" ? `${input.intent.key}.baseline` : `${key}.l${loop.number}.${slot}${slot === "selection" && loop.directorRetry ? ".d1" : ""}`, retry: 0, stage: "intention" };
  if (["close", "drain"].includes(input.operation) && pending.stage !== "receipt")
    dispatchedAction = { kind: "pending", op: input.operation, opKey: pending.key,
      ...(input.operation === "drain" && input.refs ? { input: clone(input.refs.input) } : {}),
      ...(input.operation === "drain" ? { drainDigest: canonicalDigest(input) } : {}) };
  if (input.operation === "reviewOriginals")
    input = { ...input, root: config.root, invocation: config.invocation, key: pending.key };
  if (pending.stage === "receipt" && slot === "prepare" && !invocation.currentView && !Array.isArray(pending.receipt.view?.posts)) {
    pending.retry++; delete pending.ref; pending.dispatched = false; pending.stage = "intention";
    return save().then(() => loopIO(slot, input, owner));
  }
  if (pending.stage === "receipt") {
    if (slot !== "selection") return Promise.resolve(pending.receipt);
    assertSelection();
    return Promise.resolve({ ...pending.receipt, selected: loop.task });
  }
  function run() {
    const childKey = pending.key + (pending.retry ? `.r${pending.retry}` : "");
    return Promise.resolve().then(() => {
      if (!pending.dispatched || budgetRejected(childKey)) return;
      return observeStatus(pending.ref?.runId ?? pending.ref?.key ?? childKey, true).then(observed => {
        const cause = barrier(observed, pending.ref?.runId ?? pending.ref?.key ?? childKey);
        if (cause) throw nativeBarrier(cause, pending.ref);
        if (input.operation === "taskDelta" && observed?.ok && observed.output) return observed;
      });
    }).then(observed => {
      if (observed) return [observed];
      pending.dispatched = true;
      return save().then(() => dispatch([loopIORequest(childKey, input,
        input.operation === "close" && input.refs?.worker ? gateOperationTimeout(gateTaskFor(loop.task)) : undefined)]));
    }).then(([result]) => {
      pending.ref = nativeReference(childKey, result);
      const cause = barrier(result, childKey);
      if (cause) throw nativeBarrier(cause, pending.ref, result);
      if (result?.nativeFailure) throw Object.assign(new Error(result.nativeFailure.reason),
        { nativeFailure: result.nativeFailure });
      let receipt;
      const last = result.output?.trim().split("\n").at(-1);
      try { if (utf8Bytes(last ?? "") <= 61440) receipt = JSON.parse(last); } catch (_) { /* Missing transport output is retried. */ }
      // With no committed head, the first advance can retry its original input
      // against the replacement store without charging another loop.
      const firstAdvanceQuarantined = slot === "advance" && !invocation.head &&
        receipt?.code === "store-corrupt" && receipt.recovery?.root === config.root &&
        text(receipt.recovery.storeId) && text(receipt.recovery.quarantine);
      if (receipt?.error === "loop-io" && (receipt.code === "store-busy" || firstAdvanceQuarantined) && pending.retry < 2) {
        pending.retry++; delete pending.ref; pending.dispatched = false;
        return save().then(run);
      }
      if (receipt?.error === "loop-io" && receipt.code)
        throw Object.assign(new Error(receipt.reason), { code: receipt.code, recovery: receipt.recovery });
      if (receipt?.error === "loop-io" && receipt.ledgerIntegrity === true && text(receipt.reason))
        throw Object.assign(new Error(`Execute ledger integrity failure: ${receipt.reason}`), { ledgerIntegrity: true });
      if (receipt?.error === "loop-io") {
        if (!invocation.head && viewOverflowReason(receipt) && receipt.overflowAdmission) {
          const { head, storeId, associationDigest, topicId, key } = receipt.overflowAdmission;
          if (input.operation !== "advance" || key !== pending.key ||
              associationDigest !== canonicalDigest(invocation.association) ||
              !Number.isSafeInteger(topicId) || topicId < 1 ||
              !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(storeId ?? ""))
            throw new Error("Board overflow committed admission integrity mismatch.");
          const inputRef = committedIntentReference({ seq: head?.seq, digest: head?.hash }, head);
          storeProjection = { head, P: { control: { operation: { operation: "advance", key, input: inputRef } } } };
          Object.assign(invocation, { head, storeId, boardTopicId: topicId, backlogDigest: null });
        }
        loopIOViewOverflow(receipt, pending.ref);
        const semantic = receipt.selectionRejected || receipt.replayRejected ||
          /backlog-conflict:|integrity|digest mismatch|replay differs|completed .* changed|exceeds 61440/.test(receipt.reason ?? "");
        if (!semantic && pending.retry < 2) {
          pending.retry++; delete pending.ref; return save().then(run);
        }
        const backlogConflict = receipt.reason?.startsWith("backlog-conflict:");
        if (backlogConflict && text(pending.ref.runId))
          inFlight.set(childKey, { key: childKey, runId: pending.ref.runId, role: "loop-io" });
        throw Object.assign(new Error(receipt.reason), { selectionRejected: receipt.selectionRejected === true,
          replayRejected: receipt.replayRejected === true,
          rejectedDrain: receipt.rejectedDrain,
          backlogConflict,
          ...(backlogConflict && text(pending.ref.runId) ? {
            conflictRef: { key: childKey, runId: pending.ref.runId }, originalDigest: canonicalDigest(clone(receipt)),
          } : {}) });
      }
      if (!terminalLoopIOResult(result, childKey, input.operation) || !receipt) {
        if (pending.retry >= 2) throw new Error(`loop-io ${slot} has no terminal receipt: ${result.error ?? childKey}`);
        pending.retry++; delete pending.ref; return save().then(run);
      }
      receipt = decodeLoopIOOutput(receipt);
      if (receipt.P !== undefined) {
        // P is a head-bound decision input, never part of a retained operation receipt.
        const firstAdmission = !invocation.storeId;
        // Replayed drains return their original prefix, not the current tip.
        // Consuming that receipt must not move a newer admitted intent backwards.
        if (!invocation.head || receipt.head.seq >= invocation.head.seq) {
          storeProjection = { head: clone(receipt.head), P: receipt.P };
          invocation.head = clone(receipt.head);
        }
        const compliance = slot === "closingDrain" ? loop.closingPublication?.compliance : null;
        if (slot !== "reviewOriginals" || !input.refs)
          dispatchedAction = compliance ? { kind: "launched", role: "reviewer", ...compliance } : undefined;
        invocation.storeId = receipt.storeId;
        if (input.operation === "close") {
          const worker = input.refs?.worker ?? input.gate?.worker;
          if (worker && inFlight.get(worker.key)?.runId === worker.runId)
            inFlight.delete(worker.key);
        }
        const prepared = receipt.projection?.steps.find(step => step.operation === "prepare")?.result;
        if (prepared) {
          invocation.backlogDigest = prepared.digest;
          invocation.boardTopicId = prepared.view.topicId;
        }
        if (input.operation === "advance" && firstAdmission) {
          const admission = receipt.P.prompt?.admission;
          if (!admission || admission.admissionBinding !== invocation.admissionBinding ||
              admission.association?.digest !== invocation.association.digest ||
              admission.association?.root !== config.root || admission.association.invocation !== config.invocation)
            throw new Error("Committed execute admission differs from its immutable request.");
          invocation.association = clone(admission.association);
          invocation.startedAt = admission.startedAt;
          invocation.revivalContextPeak = admission.revivalContextPeak;
          invocation.timeouts = clone(admission.timeouts);
          invocation.taskReviewer = admission.models.taskReviewer;
          invocation.taskSynthesis = admission.models.taskSynthesis;
          invocation.reviewModels = Object.fromEntries(["r1", "r2", "synthesis"]
            .map(slot => [slot, clone(admission.models[slot])]));
        }
        if (["advance", "selection"].includes(input.operation)) {
          const operation = receipt.P.control?.operation;
          if (operation?.key !== pending.key || operation.operation !== input.operation)
            throw new Error("Grouped loop-io store operation differs from its pending request.");
          const reference = committedIntentReference(operation.input, receipt.head);
          pending.steps ??= input.operation === "advance" ? ["drain", "prepare", "requests"]
            : ["drain", "apply", "requests", ...(input.baseline ? ["baseline"] : [])];
          // After COMMIT the exact request belongs to the store, not the root.
          pending.input = { operation: input.operation, root: config.root, invocation: config.invocation,
            key: pending.key, storeId: receipt.storeId, scope: `exec:${config.invocation}.e${invocation.epoch ?? 0}`,
            expectedHead: clone(receipt.head), refs: { input: reference } };
        }
        if (input.operation !== "reviewOriginals" || !input.refs) delete receipt.P;
      }
      if (input.operation === "taskDelta") {
        delete receipt.head;
        delete receipt.storeId;
      }
      if (input.operation === "reviewOriginals" && input.refs) return receipt;
      if (input.operation === "drain" && input.refs) return receipt;
      if (["advance", "selection", "close", "drain"].includes(input.operation)) {
        receiptReference(receipt);
        pending.receipt = receipt; pending.stage = "receipt";
        return save().then(() => receipt);
      }
      // Backlog content is never mission state: retain only task and digest projections.
      const { backlog, completedTasks, ...projection } = receipt;
      if (slot === "selection") {
        loop.task = projection.selected;
        loop.taskBacklogDigest = projection.digest;
        projection.selected = loop.task?.id ?? null;
        if (projection.selected === null) projection.completedTasks = completedTasks;
      }
      if (["settlement", "cancellation", "finalGaps"].includes(slot)) delete projection.view;
      pending.receipt = projection; pending.stage = "receipt";
      if (input.operation === "baseline") {
        const admitted = admitBaseline(input.intent, { ...projection, captured: true }, projection.head);
        owner.checkpoint = clone(admitted.checkpoint);
        owner.intent = clone(admitted.intent);
      }
      return save().then(() => slot === "selection" ? { ...projection, selected: loop.task } : projection);
    }).catch(error => {
      if (persistenceFailed || error.nativeFailure?.code !== "native-dispatch" || pending.retry >= 2) throw error;
      return observeStatus(pending.ref?.runId ?? childKey, true).then(observed => {
        if (text(observed?.runId)) {
          pending.ref = nativeReference(childKey, observed);
          inFlight.set(childKey, { key: childKey, runId: observed.runId, role: "loop-io" });
        }
        const cause = barrier(observed, pending.ref?.runId ?? childKey);
        if (cause) throw nativeBarrier(cause, pending.ref ?? nativeReference(childKey, observed));
        pending.retry++; delete pending.ref; pending.dispatched = false;
        return save().then(run);
      });
    });
  }
  const previousKey = pending.key + (pending.retry ? `.r${pending.retry}` : "");
  if (input.operation === "taskDelta") return run();
  if (pending.dispatched && !budgetRejected(previousKey)) {
    return observeStatus(pending.ref?.runId ?? previousKey, true).then(observed => {
      const cause = barrier(observed, pending.ref?.runId ?? previousKey);
      if (cause) throw nativeBarrier(cause, pending.ref);
      pending.retry++; delete pending.ref; pending.dispatched = false;
      return save().then(run);
    });
  }
  return run();
}
function assertSelection() {
  const receipt = loop.selection?.receipt;
  if (!receipt || receipt.selected !== (loop.task?.id ?? null) || receipt.digest !== loop.taskBacklogDigest)
    planConflict("Selected task ID or backlog digest conflicts with the selection receipt.");
}
function settleTask() {
  if (loop.settlement?.applied || loop.settlement?.queued) return Promise.resolve();
  const result = loopResults().at(-1), receipt = loop.settlementGate ?? loop.attempt?.gate?.receipt;
  if (!result || !receipt) return Promise.resolve();
  const input = { operation: "apply", root: config.root, specId: config.id,
    expectedDigest: invocation.backlogDigest, key: `${key}.l${loop.number}.settlement`,
    invocation: config.invocation, loop: loop.number, authority: backlogAuthority(), settle: true,
    director: { select: null, changes: [], reason: result.diagnosis },
    progress: { taskId: loop.task.id, progress: loop.metricSeries, remaining: result.remaining.join("; ").slice(0, 256) },
    ...(result.status === "complete" ? { confirmedUnit: { taskId: loop.task.id, kind: "unit", workerStatus: "complete", receipt } } : {}),
  };
  queueApply("settlement", input);
  loop.settlement = { queued: true, taskId: loop.task.id, complete: result.status === "complete" };
  invocation.currentView = null;
  return save().then(() => {
    // A possible second stall must be admitted before a loop archive is prepared.
    if (loop.metricSeries?.nonImproving >= 3 && (loop.task.progress?.stalls ?? 0) >= 1)
      return groupedIO("finishDrain", { operation: "drain" }, invocation);
  });
}
function needsDecisionHalt(value) {
  return { status: "needs-decision", code: "needs-decision", ...clone(value),
    reason: `Task ${value.taskId} reached two stalls. Metric series: ${JSON.stringify(value.metricSeries)}. Stall diagnoses: ${JSON.stringify(value.diagnoses)}. Human decision required: post the ruling as Board HUMAN and start a new invocation on the same worktree and backlog.` };
}
function admitSettlement(value, intention) {
    invocation.backlogDigest = value.digest; invocation.currentView = null;
    if (intention.complete) invocation.lastBacklogUnit = intention.taskId;
    if (loop.settlement) loop.settlement.applied = true;
    if (value.needsDecision) loop.halt = needsDecisionHalt(value.needsDecision);
}
function recordFinalGaps(kind, findings, outputs) {
  const changes = findings.map((finding, index) => ({ kind: "add", reason: finding.reason,
    task: { id: `final-${invocation.backlogDigest.slice(0, 16)}-${kind}-${index + 1}`, title: `final ${kind} gap ${index + 1}`, goal: finding.reason,
      expectedResult: `Resolve the final-phase finding: ${finding.reason}`,
      status: "pending", origin: { kind: "final-phase", ref: JSON.stringify(outputs[index]) },
      specRefs: [finding.source ?? "Final phase: frozen spec and amendments"], dependsOn: [],
      gates: [], metric: null, parent: null, remaining: "Director must assign focused gates before selection.",
      progress: { nonImproving: 0, last5: [] }, history: [] } }));
  const input = { operation: "apply", root: config.root, specId: config.id,
    expectedDigest: invocation.backlogDigest, key: `${key}.l${loop.number}.final-gaps`,
    invocation: config.invocation, loop: loop.number, authority: backlogAuthority(), recordGaps: true, finalGapOutputs: outputs,
    director: { select: null, changes, reason: `Final-phase ${kind} gaps` } };
  queueApply("finalGaps", input);
  invocation.currentView = null;
  return save();
}
function findingOutput(ref) {
  const path = ref?.results?.find(entry => text(entry.savedOutputPath))?.savedOutputPath ??
    ref?.results?.find(entry => text(entry.structuredOutputPath))?.structuredOutputPath ??
    (typeof ref?.outputReference === "string" ? ref.outputReference : ref?.outputReference?.path);
  if (!text(ref?.key) || !text(path)) throw new Error("Final finding lacks an exact output path.");
  return { key: ref.key, path };
}
function fullContext() {
  return `CURRENT HUMAN RESOLUTIONS (accepted input, not new permissions): ${canonicalJSON([
  ])}
ASSOCIATION (data): ${JSON.stringify(association(loop.number))}
COMPLETE IMMUTABLE SPEC SNAPSHOT:\n${config.preliminary.content}
ADDITIONAL COMPLETE SPEC SOURCES (immutable path + SHA-256): ${JSON.stringify(invocation.association.sourceRefs ?? [])}
BEFORE reasoning, planning, editing, checking, reviewing or compliance: read EVERY referenced source IN FULL
and verify its SHA-256 with existing read/hash tools. Missing/mismatched/incomplete sources => blocked,
never silently omit inherited obligations or treat summaries as full specs. Selected snapshot remains intact.
ADMITTED PLAN CONTEXT (separate from immutable base association): ${JSON.stringify(sharedContext())}
ADMISSION HUMAN AMENDMENTS (immutable, separate from base): ${JSON.stringify(invocation.amendments ?? [])}
The root delivers these exact frozen references to every phase; do not copy or restate them in sharedContext.
Read the COMPLETE admitted plan via its exact retained reference when context is unavailable here.
For admission amendments above and separately delivered current human amendments in that context, read and hash the FULL source
before affected work or whole-spec analysis. Retain its path, SHA-256 and human-delivery provenance
in results/reasons alongside unchanged base sources. A missing/changed amendment is a prerequisite
gap, not permission to replace frozen sourceRefs/snapshot/association or renew maxCycles.
Agent text and files alone are not human authority. Preserve known unmet obligations and evidence
limits from the admitted context; new checkpoint observations do not fulfill a missing historical contrast.
VERIFIED RETAINED LOOP SUMMARIES (data, not complete task originals): ${JSON.stringify(invocation.loopSummaries ?? [])}
CLOSED HISTORY REFERENCE (data): ${JSON.stringify(historyReference())}
These summaries were read by the publisher through ledger.mjs chain verification against this head.
Any further ledger read must use ledger.mjs verification against head; missing/altered records block.
The director uses these last-three summaries (no shell); the inspector reads only exact supplied native refs.`;
}
// Each closed loop's demand sources are persisted once. Observation N always reads
// loop N-1's sources, so its ring entry keeps only the ref and derives the rest.
function closedSources(number) {
  return invocation.demandSources?.find(item => item.loop === number)?.sources ?? [];
}
function retainDemandSources(latest, state = invocation) {
  state.demandSources = (state.demandSources ?? []).filter(item => item.loop === latest ||
    (state.demandObservations ?? []).some(observation => observation.loop - 1 === item.loop));
}
function retainDemandObservation(state, number, ref) {
  state.demandObservations = [...(state.demandObservations ?? []).filter(item => item.loop !== number),
    { loop: number, ref }].slice(-3);
  retainDemandSources(number - 1, state);
}
function demandHistory() {
  return (invocation.demandObservations ?? []).map(item => ({ loop: item.loop, ref: item.ref, sources: closedSources(item.loop - 1) }));
}
function pendingDemandSources() {
  return closedSources(loop.number - 1);
}
function observeDemands() {
  const sources = pendingDemandSources();
  if (!sources.length) return Promise.resolve(null);
  const retained = sources.filter(source => source.kind === "review").map(source => ({
    id: source.ref.key, ...source.ref,
  }));
  const verified = retained.length && !loop.demandOriginalsVerified
    ? loopIO("demandOriginals", { operation: "reviewOriginals", originals: retained }) : Promise.resolve();
  const childKey = demandKey();
  return verified.then(() => collect(childKey, pitakoReviewerAgent(childKey), { label: "Observe inherited demands", phase: "director" }, `${fullContext()}
INDIVIDUAL READ-ONLY DEMAND OBSERVATION, not product review or a future plan.
Read and apply scope-discipline. Read exact full originals and relevant causal references below.
For compact references, read the path and verify its SHA-256; missing or changed bytes block with the expected digest.
Observe only candidate demands and their justification against the authorized assignment,
current human decisions and limits. Follow relevant provenance, not an exhaustive historical audit.
Do not find general product defects, design additional tests, or publish another plan.
NEW CAUSAL SOURCES (exact original references): ${JSON.stringify(sources)}
PREVIOUS OBSERVATIONS AND ORIGINALS: ${JSON.stringify(demandHistory())}
Return memo, evidenceLimits and observations with source reference, demand and reason.
Empty observations and analytical uncertainty are valid advice, not veto, approval,
certification, removal orders, investigation/tests or extra human approval. Preserve necessary
work in mixed tasks, explicit requirements, admitted gates and whole-spec sufficiency.`,
    demandObservationSchema, false, analysisDispatch, undefined, true)).then(result => {
      const value = result?.structuredOutput;
      if (!result?.ok || !text(value?.memo) || !Array.isArray(value.evidenceLimits) ||
          !value.evidenceLimits.every(text) || !Array.isArray(value.observations) ||
          value.observations.some(item => !text(item?.source) || !text(item.demand) || !text(item.reason)))
        throw new Error("Demand observation lacks a usable structured original.");
      const ref = { ...loop.analysisCalls.find(call => call.key === childKey).ref, ...nativeReference(childKey, result) };
      // Constant-size ring of refs; the closed loop itself is archived without it.
      retainDemandObservation(invocation, loop.number, ref);
      // The native receipt is already durable; the director intention saves this projection.
      return { ref, body: value };
    });
}
function inspectRecovery(kind, ref, retained) {
  // Subject identity comes from the frozen work, not a replaceable output path
  // or query key. There is one finite observation route for this subject/stage.
  // The authorized replacement director has its own finite recovery route.
  const planSubject = ref.key === `${key}.l${loop.number}.director.d1` ? "loop-plan:d1" : "loop-plan";
  const subject = kind === "checkpoint" ? `checkpoint:${loop.attempt.taskId}:${loop.attempt.number}` : planSubject;
  if (loop.recoveries.some(item => !text(item.subject)))
    return Promise.reject(new Error("Retained recovery lacks immutable subject/stage; no replacement query or migration authorized."));
  let recovery = loop.recoveries.find(item => item.subject === subject);
  const existing = !!recovery;
  const producer = kind === "loop-plan" ? loop.plan?.ref : ref;
  if ((retained && retained !== recovery) || !["loop-plan", "checkpoint"].includes(kind) ||
      (recovery && (!same(recovery.association, association(loop.number)) ||
      recovery.phase !== kind || !same(recovery.source, ref) || !text(recovery.ref?.key) ||
      !["intention", "observed"].includes(recovery.stage))) ||
      !text(ref?.key) || producer?.key !== ref.key ||
      (producer?.runId && ref.runId && producer.runId !== ref.runId))
    return Promise.reject(new Error("Recovery association/stage conflict; retained unchanged."));
  if (!recovery) {
    recovery = { subject, phase: kind, association: association(loop.number),
      source: clone(ref), ref: { key: `${key}.l${loop.number}.recover${++invocation.recoverySeq}` },
      stage: "intention", disposition: "pending" };
    loop.recoveries.push(recovery);
    invocation.lastRecoveryRef = clone(recovery.ref);
  }
  const recoveryKey = recovery.ref.key;
  const recoveryRunId = recovery.ref.runId;
  const operation = storeProjection?.P.control.operation;
  const selectionSource = kind === "loop-plan" && loop.phase === "director" &&
    operation?.operation === "advance" && ref.runId
    ? { advance: clone(operation.input), director: { key: ref.key, runId: ref.runId, digest: canonicalDigest(clone(ref)) } }
    : null;
  // The settlement journal binds the inspector's request to this exact director
  // and advance. Keep the original identity until the selection consumes it.
  if (selectionSource) inFlight.set(ref.key, { key: ref.key, runId: ref.runId, role: "execution-director" });
  // Persist intent before the external query. An uncertain launch is reconciled
  // by status only: repeating runs.all with the same key is not reattachment.
  return (existing && !budgetRejected(recoveryKey) ? observeStatus(recovery.ref.runId ?? recoveryKey).then(result => {
    if ((recoveryRunId && result?.runId && result.runId !== recoveryRunId) ||
        (result?.agent && result.agent !== "pitako.execution-inspector") ||
        (result?.key && result.key !== recoveryKey && result.key !== recoveryRunId))
      throw new Error("Recovery producer/run identity conflict.");
    const cause = barrier(result, recovery.ref.runId ?? recoveryKey);
    if (cause) throw nativeBarrier(cause, { ...recovery.ref, agent: "pitako.execution-inspector" }, result);
    return retainedReadOnlyOriginal(result, recovery.ref);
  }) : save().then(() =>
    collect(recoveryKey, "pitako.execution-inspector",
    { label: kind === "checkpoint" ? "Recover writer checkpoint" : "Recover complete execution plan", phase: "recovery" },
    `EXCEPTIONAL READ-ONLY ${kind} recovery. No tests, writes or delegation.
${selectionSource ? `Selection source (data): ${canonicalJSON(selectionSource)}\n` : ""}${fullContext()}
Use existing read tools and ONLY these exact native producer/run/output references, plus Git/WIP:
${JSON.stringify(recovery.source)}
Frozen descriptor and manifest (data): ${JSON.stringify({ attempt: loop.attempt, manifest: loop.manifest })}
Expected association: ${JSON.stringify(association(loop.number))}
Recover the ORIGINAL COMPLETE native structured value, not output previews, summaries, reconstructed scopes or IDs.
Distinguish JSON binding/outputArtifactPath/outputPathMapping from optional results[].structuredOutputPath
and debug artifactPaths. Compare COMPLETE JSON values when binding and original both survive.
Changed/conflicting binding is conflict; absent binding plus original is recovered in place, no artifact copying.
An optional witness missing is not loss of an admitted full payload. If no trustworthy complete definition survives, return lost.
For checkpoint recovery, read ONLY the exact checkpoint manifest path in recovery.source.
Return original as {manifest, digest, envelope}, where manifest is that exact path,
digest is file_sha256 of its actual original bytes and envelope is its COMPLETE original JSON.
Do not reconstruct a manifest or treat an intention as a backup. Missing/incomplete/changed
manifest => lost/conflict/unresolved with concrete original evidence. No restore, tests or writes.
Recovery is limited to observing this authorized subject and stage. Do not repair functional gaps,
change artifacts, permissions, settings or budgets. If observation needs an out-of-scope action,
do not perform it: report unresolved with actor, concrete impediment, exact evidence and the
specific scope/effects expansion needed. A technical impediment is not missing human consent.
Use structured_output.`, recoverySchema))).then(result => {
    if ((result?.agent && result.agent !== "pitako.execution-inspector") ||
        (recoveryRunId && result?.runId && result.runId !== recoveryRunId) ||
        (result?.key && result.key !== recoveryKey && result.key !== recoveryRunId))
      throw new Error("Recovery producer/run identity conflict.");
    if (result?.runId) {
      recovery.ref = { ...recovery.ref, ...nativeReference(recoveryKey, result) };
      invocation.lastRecoveryRef = clone(recovery.ref);
    }
    // Save the query receipt before body validation or admission.
    return (result?.runId ? save() : Promise.resolve()).then(() => {
      const cause = barrier(result, recovery.ref.runId ?? recoveryKey);
      if (cause) throw nativeBarrier(cause, recovery.ref, result);
      if (existing && (!text(result?.runId) || !result?.structuredOutput || (recoveryRunId && result.runId !== recoveryRunId)))
        throw new Error("Recovery settlement/result uncertain; no replacement query authorized.");
      const value = result?.structuredOutput;
      if (!result?.ok || !value || !Array.isArray(value.provenance) ||
          !value.provenance.length || !value.provenance.every(text) || !text(value.reason) ||
          !["recovered", "lost", "conflict", "unresolved"].includes(value.status))
        throw new Error("Recovery has no authoritative complete observation.");
      const conflict = inspectorConflictReason(result, same);
      if (conflict) {
        const { key, runId } = recovery.ref;
        if (runId) retainHaltProducer({ key, runId }, "execution-inspector");
        loop.halt = { status: "blocked", code: "plan-conflict",
          reason: excerpt(runId ? conflict : "Inspector conflict native original integrity failure."),
          ...(runId ? { ref: { key, runId } } : {}), originalDigest: canonicalDigest(clone({ value, output: result.output })) };
        throw new Error(loop.halt.reason);
      }
      const observedProjection = projection(recoveryKey, result);
      Object.assign(recovery, observedProjection, { stage: "observed",
        ref: { ...recovery.ref, ...observedProjection.ref },
        disposition: value.status, reason: excerpt(value.reason), provenance: value.provenance });
      // The full native original remains at its exact ref. Save its disposition
      // before admission/cursor movement; never persist a reconstructed payload.
      return save().then(() => value);
    });
  });
}
function recoverPlan() {
  if (loop.task && loop.plan?.stage === "admitted") {
    assertSelection();
    return Promise.resolve(true);
  }
  const ref = loop.plan.ref;
  return observeStatus(ref.runId ?? ref.key).then(result => {
    if (barrier(result, ref.runId ?? ref.key)) throw nativeBarrier(barrier(result, ref.runId ?? ref.key), ref);
    // Status that actually contains the original full value is usable, unlike management previews.
    const original = result?.structuredOutput;
    if ((ref.agent && ref.agent !== "pitako.execution-director") ||
        (result?.agent && result.agent !== "pitako.execution-director") ||
        (ref.runId && result?.runId && result.runId !== ref.runId))
      planConflict("backlog selection producer/run identity conflict.");
    if (original && text(result.runId) && (!ref.runId || result.runId === ref.runId)) {
      planAuthority(original, result);
      if (activePlan && !same(activePlan, original)) planConflict("Conflicting complete backlog selection values.");
      activePlan = original;
      loop.plan.ref = nativeReference(ref.key, result);
      // No model recovery when both actual complete values are directly present.
      if (text(result.output) && /^[\s]*\{/.test(result.output)) {
        let binding;
        try { binding = JSON.parse(result.output); } catch (_) { planConflict("Invalid complete backlog selection binding JSON."); }
        if (!same(binding, original)) planConflict("Changed/conflicting backlog selection binding; no edits authorized.");
        loop.plan.recoverySource = { ref: loop.plan.ref, binding: "identical", comparison: "equal-full-json" };
      }
      // A complete authoritative native value does not need an optional binding
      // witness or another model consultation to become usable.
      loop.plan.recoverySource ??= { ref: loop.plan.ref, binding: "unavailable", comparison: "only-original" };
      return true;
    }
  }).then(direct => {
    if (direct === true) return null;
    if (activePlan && loop.plan.stage === "admitted") {
      planAuthority(activePlan);
      validatePlan(activePlan, loop.number, loop.manifest);
      return null;
    }
    return inspectRecovery("loop-plan", ref);
  }).then(observed => {
    if (observed === null) return true;
    if (observed.status === "conflict" || observed.binding === "changed" ||
        observed.comparison === "different-full-json") planConflict("Changed/conflicting backlog selection binding; no edits authorized.");
    // Unresolved observation is a current impediment, not proof of full loss.
    // Preserve its concrete explanation for every caller, including replay.
    if (observed.status === "unresolved")
      throw new Error(`Plan recovery unresolved: ${observed.reason}`);
    if (observed.originalAvailable && observed.original) {
      planAuthority(observed.original);
      if (activePlan && !same(activePlan, observed.original)) planConflict("Conflicting complete backlog selection values.");
      activePlan = observed.original;
      loop.plan.recoverySource = { ref: invocation.lastRecoveryRef,
        binding: observed.binding, comparison: observed.comparison };
    }
    // Admitted cache is itself a complete value; optional witnesses are not mandatory.
    if (!activePlan) return false;
    planAuthority(activePlan);
    if (loop.plan.stage === "admitted") validatePlan(activePlan, loop.number, loop.manifest);
    return true;
  }).then(recovered => {
    if (recovered && loop.plan.stage === "admitted") validatePlan(activePlan, loop.number, loop.manifest);
    // Metadata recovery never discharges another operation's native barrier.
    if (recovered && loop.halt?.code === "recovery") delete loop.halt;
    return recovered;
  });
}
// Every v6 backlog task uses checkpoint-first continuation, including read-only work.
function continueAttempt(observed, ref, task) {
  assertFallbackProducer(observed, ref);
  if (!pendingCheckpointUnit())
    throw new Error("Pending v6 task has no checkpoint intention; no replacement writer authorized.");
  if (barrier(observed, ref.runId ?? ref.key) !== "interrupted")
    return Promise.resolve(checkpointFallback(observed, ref, task));
  return observeMainRequests().then(() => {
    if (invocation.tasks[task.id]?.cancel) {
      const cause = barrier(observed, ref.runId ?? ref.key);
      if (cause) throw nativeBarrier(cause);
      if (!(observed?.ok && observed.structuredOutput && text(observed.runId)))
        throw new Error("Cancelled task has an unresolved current attempt; no continuation or replacement dispatched.");
      return observed;
    }
    return checkpointFallback(observed, ref, task);
  });
}
// A1: inspect the pertinent producer through the public status boundary when
// available. Missing inventory is unknown, never activity or a settlement proof.
function assertFallbackProducer(observed, ref) {
  const all = [observed ?? {}, ...(observed?.results ?? [])];
  // Interruption flags do not conceal an independent current activity/denial.
  if (all.some(item => ["running", "queued", "pending", "paused", "detached", "recovery", "rejected"].includes(item.state) ||
      item.detached || item.recovery || item.acceptance?.recovery || item.toolBudgetBlocked))
    throw nativeBarrier("current pertinent writer activity or native refusal", ref);
  if (all.some(item => /Blocked by pi-subagents permission rule:/.test(item.error ?? "")))
    throw nativeBarrier("native permission denial", ref);
  const independent = barrier({ ...observed, stopped: false, interrupted: false,
    results: observed?.results?.map(item => ({ ...item, stopped: false, interrupted: false })) }, ref.runId ?? ref.key);
  if (independent && !["stopped", "interrupted"].includes(independent)) throw nativeBarrier(independent, ref);
  const cause = barrier(observed, ref.runId ?? ref.key);
  if (cause && cause !== "interrupted") throw nativeBarrier(cause, ref);
  if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
      (observed?.agent && observed.agent !== "pitako.worker"))
    throw new Error("Worker producer/run identity conflicts with frozen attempt.");
}
function confirmedUnitForPending() {
  const point = invocation.lastConfirmed;
  if (point?.kind !== "unit") return undefined;
  if (point.position.loop < loop.number) {
    // lastConfirmed survives task-loop retirement; its verified seal is the
    // previous writer's baseline, not the cleared per-loop result projection.
    // Unsealed admitted attempts of the pending task do not replace it.
    if (Object.entries(invocation.tasks).some(([id, task]) => id !== loop.attempt.taskId && task.admitted.length) ||
        point.position.phase !== "implementation" || loop.cursor !== 0 ||
        point.progress.consumedLoops !== point.position.loop || invocation.consumedLoops !== loop.number ||
        point.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${point.resultRef.key}/unit.json`)
      throw new Error("Confirmed unit conflicts with admitted pending progress.");
    return clone(point);
  }
  const { taskId, attempt, resultRef, ...receipt } = point;
  const result = loopResults().find(item => item.taskId === taskId && item.attempt === attempt && same(item.ref, resultRef));
  if (!result || result.status !== "complete" || !same(result.checkpoint?.confirmation, receipt) ||
      !same(point.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
      receipt.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${result.checkpoint.key}/unit.json`)
    throw new Error("Confirmed unit conflicts with admitted pending progress.");
  return clone(point);
}
function frameIntent(sourceKey) {
  const intent = invocation.taskFrame.intents?.[sourceKey];
  if (!intent) throw new Error("Missing authenticated checkpoint source intent.");
  return intent;
}
function retainFrameIntent(intent, list, first = false) {
  const frame = invocation.taskFrame;
  const intents = frame.intents ??= {};
  if (intents[intent.key] && !same(intents[intent.key], intent))
    throw new Error("Checkpoint source intent conflicts with retained bytes.");
  intents[intent.key] ??= clone(intent);
  const keys = frame[list] ??= [];
  if (!keys.includes(intent.key)) first ? keys.unshift(intent.key) : keys.push(intent.key);
}
function renewWorkerTimeout() {
  const halt = loop?.halt, descriptor = loop?.attempt;
  if (halt?.code !== "timeout" || halt.class !== "worker" || !descriptor?.restore ||
      halt.key !== descriptor.key || effectiveTimeouts().workerMs <= halt.launchedMs ||
      (descriptor.timeoutGeneration ?? 1) >= 3) return;
  const withholdRenewal = () => {
    halt.reason = "Worker timeout renewal requires exact native timeout and terminal, barrier-free producer evidence; reconcile the retained writer. No replacement dispatched.";
    return save();
  };
  if (!nativeTimeout(descriptor.launch) ||
      descriptor.launch.key !== descriptor.key || !same(halt.ref, descriptor.launch) ||
      descriptor.launch.results?.some(entry => entry.agent && entry.agent !== "pitako.worker") ||
      descriptor.launch.launchedMs !== descriptor.timeoutMs || !text(descriptor.launch.runId)) return withholdRenewal();
  const ref = descriptor.launch;
  return Promise.resolve().then(() => observeStatus(ref.runId, true)).then(observed => {
    const cause = analysisBarrier(observed, ref.runId);
    if (cause) throw nativeBarrier(cause, ref);
    assertFallbackProducer(observed, ref);
    if (!terminalAnalysis(observed, ref) ||
        observed?.key && ![ref.key, ref.runId].includes(observed.key)) return withholdRenewal();
    return checkpointFallback(observed, ref, selectedTasks()[0], true);
  }).catch(error => {
    if (!error?.nativeBarrier || persistenceFailed) throw error;
    loop.halt = { code: "native-barrier",
      status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
      cause: error.nativeBarrier, reason: String(error.message), ref: clone(ref) };
    return save().then(() => { throw error; });
  });
}
function workerTimeoutHalt(descriptor, result, launchedMs) {
  const ref = { key: descriptor.key, runId: result.runId, agent: result.agent, launchedMs };
  if (result.terminalOutcome) ref.terminalOutcome = clone(result.terminalOutcome);
  if (result.results?.length) ref.results = result.results.map(entry => Object.fromEntries(
    ["agent", "timedOut", "terminalOutcome", "exitCode", "state"]
      .filter(field => entry[field] !== undefined).map(field => [field, entry[field]])));
  return { code: "timeout", status: "partial", class: "worker", key: descriptor.key, launchedMs, ref,
    reason: `Restoring worker ${descriptor.key} timed out at ${launchedMs} ms. ${(descriptor.timeoutGeneration ?? 1) >= 3
      ? "The three-generation limit is reached; use a new invocation."
      : `Relaunch with args.timeouts.workerMs strictly greater than ${launchedMs}.`}` };
}
function checkpointFallback(observed, ref, task, timeoutRenewal = false) {
  const descriptor = loop.attempt;
  assertFallbackProducer(observed, ref);
  if (!descriptor.checkpoint || loopResults().some(result => result.taskId === task.id && result.status === "complete"))
    throw new Error("Checkpoint fallback cannot restore a completed task or missing checkpoint.");
  const witness = checkpointObservation;
  const witnessIssue = witness && checkpointWitnessIssue(witness, { key: descriptor.key, taskId: task.id,
    attempt: descriptor.number, loop: loop.number, cursor: loop.cursor });
  if (witnessIssue) {
    const producer = checkpointWitnessRefs.get(witness);
    if (producer) retainHaltProducer(producer, "host-observation");
    loop.halt = { status: "blocked", code: "checkpoint-witness",
      reason: excerpt(producer ? witnessIssue : `Checkpoint observation native original integrity failure: ${witnessIssue}`),
      ...(producer ? { ref: producer } : {}), originalDigest: canonicalDigest(witness) };
    throw new Error(loop.halt.reason);
  }
  const evidence = witness?.evidence ?? null;
  // A restoration intention consumes this material witness durably, before
  // dispatch. Reentry reconciles that exact operation first; fresh status,
  // renamed keys and equivalent captures cannot renew its modifying route.
  const frame = invocation.taskFrame;
  const prior = frame.operations;
  if (descriptor.restore) {
    const operation = prior.find(item => item.key === descriptor.key);
    if (!operation || operation.evidence !== descriptor.restore.evidence ||
        !same(operation.confirmedPause, descriptor.restore.authority?.confirmedPause ?? null))
      throw new Error("Confirmed pause conflicts with retained restoration authority.");
  }
  const pauseRestoration = invocation.lastConfirmed?.kind === "pause" && invocation.lastConfirmed.position.loop === loop.number ||
    loopResults().some(item => item.taskId === task.id && item.checkpoint?.confirmation?.kind === "pause") ||
    prior.some(item => item.confirmedPause);
  if (pauseRestoration) {
    const { taskId, attempt, resultRef, ...receipt } = invocation.lastConfirmed ?? {};
    const result = loopResults().find(item => item.taskId === taskId && item.attempt === attempt && same(item.ref, resultRef));
    if (descriptor.pauseSource && (!same(descriptor.pauseSource.confirmation, receipt) ||
        descriptor.pauseSource.checkpoint.key !== result?.checkpoint?.key))
      throw new Error("Confirmed pause source conflicts with admitted pending progress.");
    if (taskId !== task.id || !["blocked", "continue", "gaps"].includes(result?.status) || !(result.remainingCount > 0) ||
        receipt.kind !== "pause" || !same(receipt, result.checkpoint?.confirmation) ||
        !same(receipt.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
        receipt.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${result.checkpoint.key}/pause.json` ||
        prior.some(item => item.confirmedPause && !same(item.confirmedPause.position, receipt.position)))
      throw new Error("Confirmed pause conflicts with admitted pending progress or retained restoration authority.");
  }
  // An old pause's missing witness is not a baseline for newly visible files.
  // Reconcile the exact operation/result without inventing its original evidence.
  // Non-pause recovery retains its existing material-progress routes.
  const lastRestore = descriptor.restore ?? frame.operations.at(-1);
  const renewal = timeoutRenewal;
  if (lastRestore && !renewal && (!evidence || frame.evidence.includes(evidence) || prior.some(item => item.evidence === evidence ||
      pauseRestoration && !item.evidence &&
        same(item.confirmedPause, descriptor.result?.checkpoint?.confirmation ?? lastRestore.authority?.confirmedPause ?? lastRestore.confirmedPause)))) {
    if (descriptor.restore && nativeTimeout(descriptor.launch)) {
      const launchedMs = descriptor.launch.launchedMs;
      loop.halt ??= workerTimeoutHalt(descriptor, descriptor.launch, launchedMs);
      descriptor.launch = clone(loop.halt.ref);
      return save().then(() => { throw new Error(loop.halt.reason); });
    }
    const failure = restorationPendingFailure(ref, descriptor.restore && ref.runId && barrier(observed, ref.runId) === "interrupted");
    throw Object.assign(new Error(failure.reason), { nativeFailure: failure });
  }
  checkpointObservation = undefined;
  const manifest = `${config.root}/.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json`;
  // The modifying worker reads and validates these exact bytes through the owned
  // helper before any effect. No model inspector/result rescue is a prerequisite.
  const checkpoint = { key: descriptor.checkpoint.key, manifest };
  const sources = [clone(descriptor.checkpoint), ...(frame.sources ?? []).filter(sourceKey => sourceKey !== descriptor.checkpoint.key)
    .map(frameIntent)].sort((a, b) => b.attempt - a.attempt);
  const confirmedUnit = descriptor.restore?.authority?.confirmedUnit ?? confirmedUnitForPending();
  const observations = sources.map(source => ({ key: source.key,
    manifest: `${config.root}/.pi/subagents/checkpoints/${source.key}/manifest.json` }));
  if (confirmedUnit) observations.push({ key: confirmedUnit.checkpointRef.split("/").at(-2),
    manifest: confirmedUnit.checkpointRef.replace(/unit\.json$/, "manifest.json") });
  descriptor.fallback = { stage: "admitted", source: clone(ref),
    observation: observed === undefined ? { state: "unknown", reason: "Public writer status unavailable" } : clone(observed),
    checkpoint: clone(checkpoint) };

  loop.attempt = { taskId: task.id, index: loop.cursor, number: descriptor.number + 1,
    ...(timeoutRenewal ? { timeoutGeneration: (descriptor.timeoutGeneration ?? 1) + 1 } : {}),
    timeoutMs: effectiveTimeouts().workerMs,
    key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${descriptor.number + 1}`, stage: "intention",
    continuationRef: descriptor.result?.ref ?? null, ...(descriptor.pauseSource ? { pauseSource: clone(descriptor.pauseSource) } : {}), restore: { undispatched: true,
      sourceKeys: sources.map(source => source.key), evidence, observation: checkpoint, observations,
      producer: clone(ref), authority: { pending: true, stop: false, permissionDenied: false,
        activeWriter: null, references: [ref.runId ?? ref.key, manifest],
        ...(confirmedUnit ? { confirmedUnit } : {}),
        ...(descriptor.restore?.authority?.confirmedPause || descriptor.pauseSource?.confirmation
          ? { confirmedPause: clone(descriptor.restore?.authority?.confirmedPause ?? descriptor.pauseSource.confirmation) } : {}),
        ...(descriptor.result?.checkpoint?.confirmation?.kind === "pause"
          ? { confirmedPause: clone(descriptor.result.checkpoint.confirmation) } : {}) } } };
  frame.operations.push({ key: loop.attempt.key, evidence,
    confirmedPause: clone(loop.attempt.restore.authority.confirmedPause ?? null) });
  if (evidence && !frame.evidence.includes(evidence)) frame.evidence.push(evidence);
  // Unsealed interrupted sources have no admitted manifest digest; retain their full v2 intents.
  for (const source of sources) if (!frame.restorationKeys.includes(source.key)) {
    frame.restorationKeys.push(source.key);
    retainFrameIntent(source, "sources");
  }
  // New material checkpoint evidence resolves only the prior technical suspension.
  // Native Stop/permission barriers were checked above and are never cleared here.
  if (timeoutRenewal) (loop.retired ??= []).push(clone(ref));
  if (loop.halt?.code === "recovery" || timeoutRenewal) { delete loop.halt; delete loop.outcome; }
  // Essential admission of the restoration intention precedes modifying dispatch.
  return save().then(() => null);
}
// Report-contract violations are repairable by another worker. Identity, binding,
// restoration and seal conflicts keep throwing plain errors and halt the root.
function rejectReport(message) {
  return Object.assign(new Error(message), { reportRejection: true });
}
function workerValue(result, descriptor, task, statusRef, observed) {
  const original = result?.structuredOutput;
  const value = original && { ...original };
  if ((result?.agent !== undefined && result.agent !== "pitako.worker") ||
      // A status response may echo its exact queried run ID as key. That is
      // transport association, not a different producer dispatch key.
      (result?.key !== undefined && result.key !== descriptor.key && result.key !== statusRef) ||
      (descriptor.launch?.runId && result?.runId !== descriptor.launch.runId) ||
      (Array.isArray(result?.results) && result.results.some(entry =>
        (entry.agent !== undefined && entry.agent !== "pitako.worker") ||
        (entry.exitCode !== undefined && entry.exitCode !== 0))))
    throw new Error("Worker producer/run identity conflicts with frozen attempt.");
  if (text(result?.output) && /^[\s]*\{/.test(result.output)) {
    let binding;
    try { binding = JSON.parse(result.output); } catch (_) { throw new Error("Invalid complete worker binding JSON."); }
    if (!same(binding, original)) throw new Error("Changed/conflicting worker binding.");
  }
  if (!result?.ok || !value)
    throw new Error("Worker returned no result for the frozen attempt.");
  if (!["complete", "continue", "gaps", "blocked"].includes(value.status) ||
      !(typeof value.work === "string" && value.work.length) || !Array.isArray(value.remaining) ||
      !value.remaining.every(item => typeof item === "string" && item.length))
    throw rejectReport("Worker returned an invalid work/status/remaining contract.");
  const opinion = original.continuation;
  if (opinion !== undefined && (!opinion || typeof opinion !== "object" || Array.isArray(opinion) ||
      Object.keys(opinion).some(key => !["mode", "reason"].includes(key)) ||
      !["resume", "fresh"].includes(opinion.mode) || typeof opinion.reason !== "string" || [...opinion.reason].length > 200))
    throw rejectReport("Worker returned an invalid continuation opinion (mode resume/fresh, reason at most 200 characters).");
  value.continuation = opinion === undefined ? { mode: "fresh", reason: "" } : clone(opinion);
  value.knowledge = normalizedWorkerKnowledge(value.knowledge);
  // Candidate and checkpoint authority comes from the root, never the worker.
  delete value.checkpointReceipt;
  delete value.restoreReceipt;
  delete value.candidate;
  value.taskId = descriptor.taskId;
  value.attempt = descriptor.number;
  const receipt = descriptor.gate?.receipt;
  const checks = (receipt?.gates ?? []).map(gate => ({ id: gate.id,
    result: gate.status === "pass" ? "passed" : "failed",
    before: receipt.before, after: receipt.after,
  }));
  const gates = task.gates ?? task.checks;
  const checksCurrent = !!receipt && !receipt.mutated && receipt.gates.length === gates.length &&
    gates.every(gate => receipt.gates.some(observed => observed.id === gate.id && observed.status === "pass"));
  if (observed) {
    value.candidate = candidate(observed.candidate);
    if (observed.restored) value.restoreReceipt = Object.fromEntries(
      ["checkpointRef", "partialRef", "restoredRef", "digest", "position", "candidate", "confirmedPause", "confirmedUnit"]
        .filter(key => observed.restored[key] !== undefined).map(key => [key, clone(observed.restored[key])]));
    if (observed.outcome === "sealed") value.checkpointReceipt = {
      kind: observed.kind, checkpointRef: observed.checkpointRef, digest: observed.digest,
      candidate: value.candidate, position: clone(observed.position), progress: clone(descriptor.checkpoint.progress),
    };
    if (descriptor.restore && value.status !== "blocked" && !value.restoreReceipt)
      throw new Error("Fallback worker lacks actual restoration evidence; no result admitted.");
    // A no-write completion has no journal to seal. Admit it only against the
    // baseline saved before dispatch and the passing gates on that same candidate.
    if (task.kind === "implementation" && observed.kind === "unit" && observed.outcome !== "sealed" &&
        !(observed.outcome === "observed" && value.status === "complete" && checksCurrent &&
          descriptor.baseline && same(value.candidate, candidate(descriptor.baseline)) &&
          same(value.candidate, candidate(receipt.after))))
      throw new Error("Implementation completion requires a journal-backed unit seal or an unchanged gated baseline; no unit was admitted.");
    if (value.status !== "blocked") value.status = observed.kind === "unit" ? "complete" : "continue";
  }
  // These summaries are workflow-owned projections for the existing ledger/report.
  value.workDone = value.work;
  value.diagnosis = receipt?.mutated ? "Gate commands mutated the candidate."
    : receipt?.stalled ? "Three consecutive non-improving attempts; return the task to the director."
    : receipt?.gates.filter(gate => gate.status !== "pass").map(gate =>
      `${gate.id}: ${gate.status}; ${gate.logRef}; ${gate.tail.slice(0, 128)}`).join("\n").slice(0, 4096) || value.remaining.join("; ") || value.work;
  if (observed && value.status === "continue" && !value.remaining.length)
    value.remaining = [checksCurrent ? "Worker has not reported completion." : "Resolve workflow gate failures."];
  value.usefulProgress = !receipt?.stalled;
  value.revival = value.status === "continue" ? value.diagnosis : null;
  const review = reviewProjection(descriptor.taskReview?.synthesis);
  if (review?.notes) value.diagnosis = `${value.diagnosis.slice(0, 200)}\nNon-blocking inherited notes: ${review.notes.path}`.slice(0, 360);
  if (review && !review.admitted) {
    value.remaining = review.remaining?.length ? review.remaining : review.blocking.length
      ? review.blocking : ["Resolve task review scores or spec-exclusion conflict."];
    value.diagnosis = review.diagnosis || value.remaining.join("; ").slice(0, 360);
    value.revival = review.revival || value.diagnosis;
    value.usefulProgress = !invocation.taskFrame.reviewRepair?.exhausted;
  }
  const repair = taskReviewRepair();
  if (repair?.exhausted) {
    value.usefulProgress = false;
    if (!review && repair.blocking.length) {
      value.remaining = [...value.remaining, ...repair.blocking];
      value.diagnosis = `${value.diagnosis.slice(0, 200)}; Prior review: ${repair.blocking.join("; ").slice(0, 140)}`;
    }
  }
  return { value, checks, checksCurrent };
}

function admitWorker(result, descriptor, task, recoveryRef, statusRef, observed, structural) {
  retainFrameIntent(descriptor.checkpoint, "reviewIntents");
  let parsed;
  // A report that breaks the result contract is a rejected attempt, not a root
  // halt. Its original stays in the native record; nothing from it is admitted.
  // A worker-declared block still halts with the validation reason, after the
  // root's kind-null journal verification already ran in sealAndAdmit.
  const declaredBlock = result?.structuredOutput?.status === "blocked";
  if (structural?.rejection && declaredBlock) throw new Error(structural.rejection);
  try { parsed = structural?.rejection ? structural : workerValue(result, descriptor, task, statusRef, observed); } catch (error) {
    if (!error?.reportRejection || declaredBlock) throw error;
    parsed = { rejection: String(error.message) };
  }
  const value = parsed.value;
  const taskState = invocation.tasks[task.id];
  if (value?.status === "complete" && taskState.completed)
    throw new Error("Duplicate task completion rejected at admission.");
  const original = descriptor.gate?.receipt?.workerOriginal;
  if (descriptor.gate && (!original || original.key !== descriptor.key ||
      original.runId !== descriptor.launch.runId || !text(original.path) || !/^[a-f0-9]{64}$/.test(original.sha256 ?? "")))
    throw new Error("Worker admission lacks its verified native original.");
  const base = { ...projection(descriptor.key, result), taskId: descriptor.taskId, attempt: descriptor.number,
    ...(original ? { ref: {
      key: original.key, runId: original.runId, path: original.path, digest: original.sha256,
    } } : {}),
    ...(observed ? { candidate: candidate(observed.candidate) } : {}),
    ...(descriptor.checkpoint ? { checkpoint: {
      key: descriptor.checkpoint.key, manifest: `.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json`,
    } } : {}) };
  const projected = parsed.rejection ? { ...base, status: "rejected", rejection: parsed.rejection,
    workDone: `Rejected worker report: ${parsed.rejection}`, diagnosis: parsed.rejection,
    remaining: [], remainingCount: 0, usefulContinuation: false } : { ...base, candidate: candidate(value.candidate),
    ...(descriptor.restore ? { restore: { observation: descriptor.restore.observation,
      receipt: value.restoreReceipt ?? null, producer: descriptor.restore.producer } } : {}),
    status: value.status, workDone: excerpt(value.workDone), diagnosis: excerpt(value.diagnosis),
    ...(descriptor.taskReview?.synthesis ? { taskReview: clone(descriptor.taskReview) } : {}),
    knowledge: { key: descriptor.key }, gateFailures: retainedText(value.diagnosis, { units: 4096, bytes: 12288 }),
    remaining: value.remaining.slice(0, 4).map(excerpt), remainingCount: value.remaining.length,
    checks: { current: parsed.checksCurrent, count: parsed.checks.length,
      passed: parsed.checks.filter(check => check.result === "passed").length,
      failed: parsed.checks.filter(check => check.result === "failed").length,
      notRun: parsed.checks.filter(check => check.result === "not-run").length },
    usefulContinuation: value.status === "continue" && value.usefulProgress &&
      value.remaining.length > 0 && text(value.revival) && text(value.diagnosis),
    continuationIdentity: continuationIdentity(value),
  };
  const peak = descriptor.gate?.receipt?.contextPeak ?? null;
  descriptor.revival = { ...(descriptor.revival ?? { decision: "fresh", code: peak === null ? "missing-peak" : "fresh-dispatch" }),
    opinion: value?.continuation.mode ?? "fresh", reason: value?.continuation.reason ?? "", peak };
  descriptor.capturedPaths = observed?.capturedPaths ?? 0;
  if (!parsed.rejection) (invocation.taskFrame.workerKnowledge ??= {})[descriptor.key] = clone(value.knowledge);
  projected.revival = clone(descriptor.revival);
  if (recoveryRef) projected.ref = { ...projected.ref, ...descriptor.launch,
    recovery: { ref: recoveryRef, field: "structuredOutput.workerResult" } };
  if (!descriptor.gate && invocation.taskFrame.identities.includes(projected.continuationIdentity))
    projected.usefulContinuation = false;
  // The seal is not confirmed until this result and pointer are saved together.
  // A failed essential save leaves the previous durable point authoritative.
  if (value?.checkpointReceipt) {
    projected.checkpoint.confirmation = clone(value.checkpointReceipt);
    invocation.lastConfirmed = { ...clone(value.checkpointReceipt), taskId: descriptor.taskId,
      attempt: descriptor.number, resultRef: clone(projected.ref) };
  }
  if (projected.continuationIdentity) invocation.taskFrame.identities.push(projected.continuationIdentity);
  if (!parsed.rejection) recordOriginalProblem(task, descriptor.gate?.receipt, descriptor);
  if (!taskState.admitted.includes(projected.status)) taskState.admitted.push(projected.status);
  // A superseded pending attempt no longer has a task-owned full result.
  loop.results = loop.results.map(entry => !entry.ref && entry.taskId === projected.taskId &&
    entry.attempt === taskState.last?.attempt ? taskState.last : entry);
  loop.results = loop.results.map(entry => entry.sealed ? sealedResult(entry) : entry);
  taskState.last = projected.status === "complete" ? null : projected;
  if (projected.status === "complete") {
    loop.settlementGate = clone(descriptor.gate.receipt);
    taskState.completed = { ...clone(projected), prerequisiteResults: clone(prerequisiteResults(task)) };
    if (invocation.excludedScope?.[task.id]) invocation.excludedScope[task.id].completed = true;
  }
  loop.results.push({ taskId: projected.taskId, attempt: projected.attempt });
  loop.attempt.result = projected;
  loop.attempt.stage = "result";
  delete loop.attempt.received;
  if (value?.checkpointReceipt) prepareSeal(projected);
  // A recovered rejection does not settle the interrupted producer.
  if (["recovery", "native-barrier"].includes(loop.halt?.code)) delete loop.halt;
  if (projected.status === "blocked") retainWorkerBlock(projected);
  if (observed) currentCandidate = candidate(observed.candidate);
  if (parsed.rejection) return projected;
  currentCandidate = projected.candidate;
  return parsed.value;
}
// Native status of a settled async child carries no structuredOutput, and a
// budget relaunch is a new top-level run without the old run's child receipts.
// Retain the exact received writer result until admission so reentry seals and
// admits it instead of rolling back finished journaled work. Admission consumes it.
// Recovery cache only: larger native results still follow normal admission.
// HUMAN #2885: 24 KiB is >5x the measured current-schema worker maximum.
const RECEIVED_RESULT_LIMIT = 24 * 1024;
function normalizedWorkerKnowledge(knowledge) {
  const bounded = content => retainedText(content, { bytes: 2048 });
  return { findings: Array.isArray(knowledge?.findings) ? knowledge.findings.filter(text).slice(0, 8).map(bounded) : [],
    handoff: bounded(knowledge?.handoff) };
}
function workerKnowledge(result) {
  const reference = result?.knowledge;
  if (!reference?.key) return reference;
  // New projections cite their keyed owner; frozen older bodies remain inline.
  const knowledge = frameProjection("workerKnowledge", reference.key);
  if (!knowledge) throw new Error(`Missing worker knowledge projection: ${reference.key}.`);
  return knowledge;
}
function frameProjection(collection, projectionKey) {
  const frames = [invocation.taskFrame, invocation.sealPending?.record?.body?.frame,
    ...(invocation.intentions ?? []).filter(entry => entry.operation === "ledger" && entry.input.record.kind === "unit")
      .map(entry => entry.input.record.body.frame)];
  return frames.find(frame => frame?.[collection]?.[projectionKey])?.[collection][projectionKey];
}
function retainReceived(result) {
  if (barrier(result) || !result?.ok || !result.structuredOutput || !text(result.runId)) return;
  const received = clone({ ok: true, agent: result.agent, key: result.key, runId: result.runId,
    structuredOutput: { ...result.structuredOutput, knowledge: normalizedWorkerKnowledge(result.structuredOutput.knowledge) },
    ...(text(result.output) && /^[\s]*\{/.test(result.output) ? { output: result.output } : {}),
    ...(Array.isArray(result.results) ? { results: result.results.map(entry => ({ agent: entry?.agent, exitCode: entry?.exitCode })) } : {}) });
  if (prettyBytes({ [key]: { loop: { attempt: { received } } } }) <= RECEIVED_RESULT_LIMIT) loop.attempt.received = received;
}
// A positive barrier or another producer keeps the existing route; only the
// same settled launch, without its payload in this observation, is completed.
function receivedResult(observed, ref) {
  const received = loop.attempt.received;
  if (!received || received.runId !== ref.runId ||
      barrier(observed, ref.runId ?? ref.key) || observed?.structuredOutput ||
      (observed?.runId && observed.runId !== received.runId)) return observed;
  const result = { ...clone(ref), ...clone(received) };
  if (Array.isArray(ref.results) && ref.results.length === received.results?.length &&
      received.results.every((entry, index) => entry.agent === ref.agent &&
        (ref.results[index].agent === undefined || ref.results[index].agent === entry.agent)))
    result.results = ref.results.map((entry, index) => ({ ...clone(entry), ...clone(received.results[index]) }));
  return result;
}
function sealerKey(attemptKey, retry) {
  return `${attemptKey}.seal${retry ? `.r${retry}` : ""}`;
}
let settledTaskSealer;
// A retained seal intention is observed before any fallback, recovery or re-seal.
// Grouped closes resume verified markers; legacy seals keep the fresh-dispatch route.
function observePendingSealer() {
  if (loop?.attempt?.recoveredSeal) return Promise.resolve();
  const pending = loop?.attempt?.seal;
  const close = loop?.attempt?.close;
  if (loop?.attempt?.stage === "result") return Promise.resolve();
  if (!pending?.retry && !close?.dispatched) return Promise.resolve();
  // A grouped close consumes seal index 0; a later legacy re-seal is the newest producer.
  const closeKey = close && close.key + (close.retry ? `.r${close.retry}` : "");
  const ref = close?.dispatched && (pending?.retry ?? 0) <= 1 ? close.ref?.key === closeKey ? close.ref : { key: closeKey, agent: "pitako.loop-io" }
    : { key: sealerKey(loop.attempt.key, pending.retry - 1), agent: "pitako.checkpoint-sealer" };
  const key = ref.key;
  if (budgetRejected(key) || pending?.reconciled === key) return Promise.resolve();
  return observeStatus(ref.runId ?? key, true).then(observed => {
    const cause = observed?.state === "unknown" ? null : barrier(observed, ref.runId ?? key);
    if (cause) throw nativeBarrier(cause, ref);
    if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
        (observed?.agent && (ref.runId ? observed.agent !== ref.agent : pitakoAgentFamily(observed.agent) !== pitakoAgentFamily(ref.agent))))
      throw new Error("Sealer producer/run identity conflicts with the pending seal.");
    if (loop.attempt.taskReview?.synthesis && ref.agent === "pitako.checkpoint-sealer" &&
        observed?.ok && observed.output?.trimStart().startsWith("{")) {
      const receipt = JSON.parse(observed.output);
      if (receipt.outcome === "sealed" && !same(candidate(receipt.candidate), currentCandidate))
        throw new Error("Current candidate differs from the settled task sealer; recovery required.");
      if (receipt.outcome === "sealed") settledTaskSealer = { key, result: observed };
    }
  });
}
function validFinalGateRecord(record, receipt, receiptDigest, opKey, invocation, epoch) {
  const { seq, digest, prev, requestDigest, producer, execDigest } = record ?? {};
  const hash = /^[a-f0-9]{64}$/;
  return Number.isSafeInteger(seq) && seq > 0 && hash.test(digest ?? "") && hash.test(requestDigest ?? "") &&
    hash.test(execDigest ?? "") && typeof producer === "string" && producer.replace(/\.r[123]$/, "") === opKey &&
    (prev === null || hash.test(prev ?? "")) && canonicalDigest(receipt) === receiptDigest &&
    canonicalDigest({ scope: `exec:${invocation}.e${epoch}`, seq, kind: "final-gate",
      opKey: `final-gate:${opKey}`, requestDigest, prev,
      bodyDigest: canonicalDigest({ producer, execDigest, receipt, receiptDigest }) }) === digest;
}

// Gate intentions and receipts survive relaunch; a saved seal never reruns gates.
function verifyAttempt(descriptor, task, value, reuse) {
  const pending = descriptor.gate ??= { key: `${descriptor.key}.gate`, stage: "intention", retry: 0 };
  if (pending.stage === "receipt") return Promise.resolve(pending.receipt);
  if (descriptor.seal) return Promise.reject(new Error("Seal intention has no durable gate receipt; recovery required."));
  const gateTask = pending.task ??= gateTaskFor(task);
  pending.gateFloorMs ??= effectiveTimeouts().gateFloorMs;
  let finalRequestDigest;
  function runGate() {
    const gateKey = `${pending.key}${pending.retry ? `.r${pending.retry}` : ""}`;
    return Promise.resolve().then(() => {
      if (!pending.dispatched || budgetRejected(gateKey)) return;
      return observeStatus(pending.ref?.runId ?? gateKey, true).then(status => {
        const cause = analysisBarrier(status, pending.ref?.runId ?? gateKey);
        if (cause) throw nativeBarrier(cause, pending.ref);
        if (pending.ref?.runId && status?.runId && pending.ref.runId !== status.runId ||
            status?.key && ![gateKey, pending.ref?.runId].includes(status.key) ||
            status?.agent && pitakoAgentFamily(status.agent) !== "loop-io")
          throw new Error("Gate producer/run identity conflicts with the retained intention.");
        if (status?.ok && status.output) return status;
        if (nativeTimeout(status)) return status;
        if (pending.retry >= 2) throw new Error(`Gate lacks a valid terminal receipt; inspect ${gateKey}`);
        pending.retry++; pending.dispatched = false; delete pending.ref;
        return save().then(() => runGate()).then(receipt => ({ gateReceipt: receipt }));
      });
    }).then(observed => {
      if (observed?.gateReceipt) return [{ gateReceipt: observed.gateReceipt }];
      if (observed) return [observed];
      // Admission exhaustion proves no child launched and preserves this key.
      pending.stage = "intention"; pending.dispatched = true;
      const gateInput = descriptor.checkpoint && descriptor.launch?.runId &&
          !descriptor.restore && !reuse && !descriptor.gateGeneration &&
          ["selection", "close", "baseline"].includes(storeProjection?.P.control.operation?.operation)
        ? storedWorkerCloseInput({ root: config.root, invocation: config.invocation,
          storeId: invocation.storeId, epoch: invocation.epoch ?? 0, head: invocation.head,
          intent: descriptor.intent, gateFloorMs: pending.gateFloorMs,
          associationDigest: canonicalDigest(invocation.association), admissionBinding: invocation.admissionBinding },
          { key: descriptor.key, runId: descriptor.launch.runId }, storeProjection.P.control.operation.input, "gate")
        : {
        operation: "gate", root: config.root, specId: config.id, invocation: config.invocation,
        loop: loop.number, attempt: descriptor.number, key: gateKey, task: gateTask,
        workerStatus: value.status, writerSettled: true, checkpoint: descriptor.checkpoint,
        requestObservation: invocation.requestObservation ?? 0,
        ...(descriptor.checkpoint ? { worker: { key: descriptor.key, runId: descriptor.launch.runId } } : {}),
        ...(reuse ? { reuse } : {}),
      };
      dispatchedAction = { kind: "pending", op: "gate", opKey: pending.key,
        ...(reuse && descriptor === loop.finalAttempt ? { input: invocation.lastFinalGate } : {}),
        gateTimeoutMs: gateOperationTimeout(gateTask),
        gateTimeouts: task.gates.map(gate => gate.timeoutMs ?? 1800000),
        gateMetricMs: task.metric ? 1800000 : 0 };
      const replayFinal = descriptor === loop.finalAttempt && pending.retry && pending.key.endsWith(".acceptance.gate");
      if (descriptor === loop.finalAttempt && !pending.retry) {
        const { operation, ...request } = JSON.parse(JSON.stringify(gateInput));
        finalRequestDigest = canonicalDigest(request);
      }
      return save().then(() => dispatch([loopIORequest(gateKey,
        replayFinal ? finalGateReplayRequest(executeCursor(), gateKey) : gateInput, gateOperationTimeout(gateTask))]));
    }).then(([result]) => {
      if (result.gateReceipt) return result.gateReceipt;
      pending.ref = { ...pending.ref, ...nativeReference(gateKey, result) };
      const cause = analysisBarrier(result, gateKey);
      if (cause) return save().then(() => { throw nativeBarrier(cause, pending.ref, result); });
      if (nativeTimeout(result)) return haltGateTimeout(descriptor, "gate-transport", gateOperationTimeout(gateTask), result)
        .then(() => { throw new Error(loop.halt.reason); });
      let receipt;
      if (typeof result?.output === "string") {
        const last = result.output.trim().split("\n").at(-1);
        if (utf8Bytes(last ?? "") <= 61440) {
          try { receipt = JSON.parse(last); } catch (_) { /* Malformed output is not gate evidence. */ }
        }
      }
      if (receipt?.error === "loop-io" && receipt.code === "store-busy" && pending.retry < 2) {
        pending.retry++; pending.dispatched = false; delete pending.ref;
        return save().then(runGate);
      }
      if (receipt?.error === "loop-io" && receipt.code)
        throw Object.assign(new Error(receipt.reason), { code: receipt.code, recovery: receipt.recovery });
      loopIOViewOverflow(receipt, pending.ref);
      const failures = [result, ...(result?.results ?? [])].filter(Boolean);
      const terminal = result?.ok && pitakoAgentFamily(result.agent) === "loop-io" && text(result.runId) &&
        (result.key === undefined || result.key === gateKey) && !result.state && !result.terminalOutcome &&
        Array.isArray(result.results) && result.results.length === 1 && result.results[0].exitCode === 0 &&
        failures.every(item => !item.error && !item.outputSaveError && !item.metadataSaveError && !item.transcriptError &&
          !item.outputPartial && !item.truncation && !item.timedOut && !item.processSignal &&
          (item.exitCode === undefined || item.exitCode === 0));
      if (terminal) receipt = decodeLoopIOOutput(receipt);
      if (descriptor === loop.finalAttempt && receipt?.selectionHead) {
        const { receipt: value, finalGate, receiptDigest, storeId, selectionHead, selectionInput } = receipt;
        if (!same(selectionHead, invocation.head) || !same(selectionInput, storeProjection.P.control.operation.input) ||
            finalGate?.requestDigest !== finalRequestDigest)
          throw new Error("Final acceptance retry selection integrity mismatch.");
        receipt = { ...value, finalGate, receiptDigest, storeId };
      }
      const committedGate = receipt?.P ? { head: receipt.head, P: receipt.P, storeId: receipt.storeId } : null;
      if (receipt?.P) {
        const { head, P, storeId, ...gateReceipt } = receipt;
        receipt = gateReceipt;
      }
      const { finalGate, storeId: finalStoreId, receiptDigest: finalReceiptDigest, ...finalReceipt } = receipt ?? {};
      if (finalGate) receipt = finalReceipt;
      if (descriptor !== loop.finalAttempt)
        receipt = readTaskGateWire(receipt, gateTask.gates, committedGate?.P.prompt.execution?.worker?.reference);
      if (!terminal || !validGateReceipt(receipt, gateTask, value.status)) {
        // Native permission/Stop/activity is never a transport retry.
        if (result?.nativeFailure || pending.retry >= 2) return save().then(() => {
          const error = new Error(`Gate lacks a valid terminal receipt; inspect ${gateKey}: ${result?.error ?? receipt?.reason ?? "invalid gate stdout"}`);
          if (result?.nativeFailure) error.nativeFailure = result.nativeFailure;
          throw error;
        });
        pending.retry++; pending.stage = "intention"; pending.dispatched = false; delete pending.ref;
        return save().then(runGate);
      }
      if (committedGate) {
        committedIntentReference(descriptor.intent, committedGate.head);
        if (committedGate.storeId !== invocation.storeId ||
            committedGate.P.control.operation?.operation !== "gate" ||
            committedGate.P.control.operation.key !== pending.key)
          throw new Error("Committed gate differs from its pending worker.");
        storeProjection = { head: clone(committedGate.head), P: committedGate.P };
        invocation.head = clone(committedGate.head);
      }
      if (task.id === "final-acceptance") {
        if (finalStoreId !== invocation.storeId ||
            !validFinalGateRecord(finalGate, finalReceipt, finalReceiptDigest, pending.key, config.invocation, invocation.epoch ?? 0) ||
            finalGate.seq <= invocation.head.seq)
          throw new Error("Final acceptance gate record integrity mismatch.");
        const { seq, digest, producer } = finalGate;
        pending.record = { seq, digest };
        pending.producer = producer;
        invocation.head = { seq, hash: digest };
      }
      pending.receipt = receipt; pending.stage = "receipt";
      if (inFlight.get(descriptor.key)?.runId === descriptor.launch?.runId)
        inFlight.delete(descriptor.key);
      // Only a fresh receipt observes the current candidate; cached receipts do not.
      currentCandidate = candidate(receipt.after);
      loop.metricSeries = clone(receipt.progress);
      invocation.currentView = clone(receipt.view);
      invocation.boardTopicId = receipt.view.topicId;
      return save().then(() => receipt);
    });
  }
  return runGate();
}

function acceptanceResults(closingLoop = loop) {
  const receipt = closingLoop?.finalAttempt?.gate?.receipt;
  const humanIds = new Set((receipt?.view?.posts ?? []).filter(post => post.type === "HUMAN").map(post => post.id));
  const blocking = [], excepted = [];
  for (const result of receipt?.gates ?? []) {
    const exception = closingLoop.acceptance?.find(command => command.id === result.id)?.exception;
    if (exception && humanIds.has(exception.humanRef)) excepted.push({ ...result, ...exception });
    else blocking.push(result);
  }
  return { blocking, excepted };
}
function finalAcceptanceHalt(code, reused, results) {
  return { status: "blocked", code, reason: excerpt(code === "repeat-acceptance"
    ? `Repeated final acceptance from loop ${reused.loop} (${reused.gateKey}) still fails: ${results}`
    : `Final acceptance environment failure: ${results}`) };
}
function retainFinalAcceptanceHalt(code, receipt, failures) {
  const { key, runId } = loop.finalAttempt.gate.ref;
  inFlight.set(key, { key, runId, role: "loop-io" });
  loop.halt = finalAcceptanceHalt(code, receipt.reused,
    failures.map(gate => `${gate.id}: ${gate.status} (${gate.logRef})`).join("; "));
}
function acceptanceBrief() {
  const gate = loop.finalAttempt?.gate, receipt = gate?.receipt;
  const { blocking, excepted } = acceptanceResults();
  if (receipt && !gate.record) throw new Error("Final acceptance gate record integrity mismatch.");
  const evidence = receipt ? {
    store: { storeId: invocation.storeId, scope: `exec:${config.invocation}.e${invocation.epoch ?? 0}`, seq: gate.record.seq },
    digest: gate.record.digest,
    gates: blocking.map(({ id, status, exit, ms, logRef }) => ({ id, status, exit, ms, logRef })),
    after: receipt.after, mutated: receipt.mutated, currentAcceptance: currentAcceptance(),
  } : null;
  return `Blocking final acceptance (mandatory checks): ${JSON.stringify(evidence)}.
Excepted acceptance results: ${JSON.stringify(excepted)}.
Acceptance history: ${canonicalJSON(loop.acceptanceHistory ?? loop.selection?.receipt?.acceptanceHistory ?? [])}.
Inspect acceptanceHistory and report as a gap any acceptance replacement that narrows, filters or relaxes a command and cites no HUMAN post ID that is current in this execute topic.
An excepted failure covered by a current HUMAN is reported, not a gap or repair task.`;
}
function currentAcceptance() {
  const receipt = loop.finalAttempt?.gate?.receipt;
  return loop.kind === "final" && loop.finalAttempt?.gate?.stage === "receipt" &&
    Array.isArray(loop.acceptance) && loop.acceptance.length > 0 &&
    validGateReceipt(receipt, { gates: loop.acceptance, metric: null }, "complete") &&
    !receipt.mutated && same(candidate(receipt.after), currentCandidate) &&
    acceptanceResults().blocking.every(gate => gate.status === "pass" && gate.exit === 0);
}

function validGateReceipt(receipt, task, status) {
  try {
    candidate(receipt.before); candidate(receipt.after);
    if (receipt.contextPeak !== undefined && receipt.contextPeak !== null &&
        (!Number.isSafeInteger(receipt.contextPeak) || receipt.contextPeak < 0)) return false;
    if (typeof receipt.mutated !== "boolean" || receipt.mutated !== !same(candidate(receipt.before), candidate(receipt.after)) ||
        typeof receipt.stalled !== "boolean" || !Array.isArray(receipt.gates) ||
        !Number.isSafeInteger(receipt.progress?.nonImproving) || receipt.progress.nonImproving < 0 ||
        receipt.stalled !== (receipt.progress.nonImproving >= 3) ||
        !Array.isArray(receipt.progress.last5) || receipt.progress.last5.length > 5 ||
        !Number.isSafeInteger(receipt.view?.topicId) || !Array.isArray(receipt.view.posts) ||
        !text(receipt.view.authority) || !Number.isSafeInteger(receipt.view.omitted) || receipt.view.omitted < 0) return false;
    const expected = status === "complete" || !task.metric ? task.gates : [];
    return receipt.gates.length === expected.length && new Set(receipt.gates.map(g => g.id)).size === expected.length &&
      expected.every(gate => receipt.gates.some(result => result.id === gate.id &&
        ["pass", "fail", "timeout", "error"].includes(result.status) &&
        (result.exit === null || Number.isInteger(result.exit)) && Number.isFinite(result.ms) && result.ms >= 0 &&
        typeof result.tail === "string" && utf8Bytes(result.tail) <= 2048 && text(result.logRef))) &&
      (task.metric ? receipt.metric && (receipt.metric.value === null || Number.isFinite(receipt.metric.value)) &&
        (receipt.metric.error === null || text(receipt.metric.error)) : receipt.metric === null);
  } catch (_) { return false; }
}
function closeAttemptInput(descriptor, task, value) {
  const gateKey = descriptor.gate?.key ?? `${descriptor.key}.gate`;
  const gateTask = descriptor.close?.input?.gate?.task ?? descriptor.gate?.task ?? gateTaskFor(task);
  const next = checkpointIntent(task.id, descriptor.number + 1,
    `${key}.l${loop.number}.t${loop.cursor + 1}.a${descriptor.number + 1}`);
  const admitted = next.progress.admitted[task.id] ??= [];
  if (!admitted.includes("continue")) admitted.push("continue");
  // These variants are inert until the workflow admits the matching pause.
  const sealed = clone(next); sealed.progress.previous = null;
  const nextBaselines = descriptor.close?.input?.nextBaseline ?? { sealed, observed: next };
  const seal = { v: 1, intent: descriptor.checkpoint,
    ...(descriptor.restore ? { restoreSources: descriptor.restore.sourceKeys.map(sourceKey => {
      const source = frameIntent(sourceKey);
      if (!source) throw new Error("Missing authenticated restoration source intent.");
      return source;
    }) } : {}) };
  // Compare to the committed original, not the possibly normalized received result.
  // A close without a prior gate needs no fallback: its frame hasn't admitted this worker's knowledge yet.
  const workerOriginal = storeProjection?.P.prompt?.execution?.worker;
  return { operation: "close", taskFrame: clone(invocation.taskFrame),
    gate: { root: config.root, specId: config.id, invocation: config.invocation,
      loop: loop.number, attempt: descriptor.number, key: gateKey, task: gateTask,
      workerStatus: value.status, writerSettled: true, checkpoint: descriptor.checkpoint,
      ...(descriptor.revival ? { revival: { decision: descriptor.revival.decision } } : {}),
      worker: { key: descriptor.key, runId: descriptor.launch.runId } },
    seal: { unit: seal, pause: seal }, nextBaseline: nextBaselines,
    continuation: encodeContinuation({ attempt: { ...Object.fromEntries(["taskId", "index", "number", "key", "timeoutMs",
      "checkpoint", "intent", "baseline", "bindingKey", "revival", "resume", "resumeAfter", "boardPostIds",
      "taskReview", "restore", "pauseSource"].filter(field => descriptor[field] !== undefined)
      .map(field => [field, clone(descriptor[field])])), launch: { key: descriptor.key, runId: descriptor.launch.runId } },
      taskState: clone(invocation.tasks[task.id]), taskFrame: clone(invocation.taskFrame),
      results: clone(loop.results), recoveries: clone(loop.recoveries),
      usage: clone(loop.usage),
      metricSeries: clone(loop.metricSeries ?? task.progress), lastConfirmed: clone(invocation.lastConfirmed ?? null) }, workerOriginal) };
}
function storedWorkerCloseInput(position, worker, input, operation = "close") {
  return { operation, root: position.root, invocation: position.invocation,
    key: `${worker.key}.${operation}`, storeId: position.storeId,
    scope: `exec:${position.invocation}.e${position.epoch}`, expectedHead: clone(position.head),
    refs: { input, intent: position.intent, worker: { key: worker.key, runId: worker.runId },
      gateFloorMs: position.gateFloorMs,
      request: { associationDigest: position.associationDigest, admissionBinding: position.admissionBinding,
        missionId: config.missionId, missionPath: config.missionPath, sourceRefs: config.sourceRefs ?? [],
        amendments: config.amendments ?? [], specId: config.id } } };
}
function canReferenceWorkerClose(descriptor, value) {
  return !descriptor.close && descriptor.number === 1 && !descriptor.restore &&
    !descriptor.revival && ["blocked", "continue"].includes(value.status) &&
    storeProjection?.P.control.operation?.operation === "selection" && !invocation.intentions?.length;
}
function recordWorkerClose(descriptor, result, task) {
  let value;
  try { value = workerValue(result, descriptor, task).value; }
  catch (error) {
    if (error.reportRejection) return;
    throw error;
  }
  // Settled later attempts and repairs have the same consuming-writer boundary.
  // Reference-only first-attempt transport is an optimization, not that boundary.
  const op = value.status === "complete" ? "gate" : "close";
  dispatchedAction = { kind: "pending", op, opKey: `${descriptor.key}.${op}`,
    gateTimeoutMs: dispatchedAction?.gateTimeoutMs ?? gateOperationTimeout(gateTaskFor(loop.task)),
    ...(op === "gate" ? { gateTimeouts: task.gates.map(gate => gate.timeoutMs ?? 1800000),
      gateMetricMs: task.metric ? 1800000 : 0 } : {}) };
}
function closeAttempt(descriptor, task, value) {
  if (descriptor.close?.input?.refs) {
    // Reference conversion happens only after all close decisions and request effects settle.
    if (descriptor.close.stage !== "receipt" || descriptor.gate?.stage !== "receipt")
      throw new Error("Referenced close lacks its admitted gate receipt.");
    if (!same(currentCandidate, candidate(descriptor.gate.receipt.after))) {
      const reason = "Current candidate differs from the saved close gate receipt; recovery required, gates must not be rerun.";
      loop.halt = { status: "blocked", code: "recovery", reason, ref: clone(descriptor.close.ref) };
      return save().then(() => { throw new Error(reason); });
    }
    return Promise.resolve(groupedStep(descriptor.close.receipt, "seal"));
  }
  const savedReceipt = descriptor.close?.stage === "receipt";
  const input = closeAttemptInput(descriptor, task, value);
  const gateTask = input.gate.task;
  const nextBaselines = input.nextBaseline;
  const gateKey = input.gate.key;
  const selection = storeProjection?.P.control.operation;
  // Freeze the same reference-only request on first dispatch and on cursor replay.
  const storedInput = canReferenceWorkerClose(descriptor, value)
    ? storedWorkerCloseInput({ root: config.root, invocation: config.invocation,
      storeId: invocation.storeId, epoch: invocation.epoch ?? 0, head: invocation.head,
      intent: descriptor.intent, gateFloorMs: effectiveTimeouts().gateFloorMs,
      associationDigest: canonicalDigest(invocation.association), admissionBinding: invocation.admissionBinding },
      { key: descriptor.key, runId: descriptor.launch.runId }, selection.input)
    : input;
  return groupedIO("close", storedInput, descriptor).then(transport => {
    const operation = storeProjection?.P && storeProjection.head.seq === transport.head?.seq
      && storeProjection.P.control?.operation;
    const committedInput = operation?.operation === "close" && operation.key === descriptor.close.key
      ? committedIntentReference(operation.input, transport.head) : null;
    const gate = groupedStep(transport, "gate"), selected = groupedStep(transport, "seal");
    gate.receipt = readTaskGateWire(gate.receipt, gateTask.gates, gate.workerOriginal);
    const view = transport.projection.view ?? (descriptor.gate?.stage === "receipt" ? invocation.currentView : null);
    if (!validGateReceipt({ ...gate.receipt, view }, gateTask, value.status) ||
        gate.contextPeak !== null && (!Number.isSafeInteger(gate.contextPeak) || gate.contextPeak < 0) ||
        transport.projection.contextPeak !== gate.contextPeak)
      throw new Error("Close lacks a valid gate receipt.");
    const passed = !gate.receipt.mutated && gate.receipt.gates.length === gateTask.gates.length &&
      gateTask.gates.every(command => gate.receipt.gates.some(result => result.id === command.id && result.status === "pass"));
    const kind = value.status === "complete" && passed ? "unit" : "pause";
    if (selected.kind !== kind || selected.workerStatus !== value.status || selected.mutated !== gate.receipt.mutated ||
        !same(candidate(selected.after), candidate(gate.receipt.after)))
      throw new Error("Close seal selection differs from workflow evidence.");
    receiptReference(selected.gate);
    descriptor.gate = { key: gateKey, stage: "receipt", ref: clone(descriptor.close.ref),
      receipt: { ...gate.receipt, contextPeak: transport.projection.contextPeak } };
    const requests = groupedStep(transport, "nextRequests"), baseline = groupedStep(transport, "nextBaseline");
    const earlier = groupedStep(transport, "requests");
    const observed = requests.observed;
    if (observed && (observed.taskId !== task.id || !Number.isSafeInteger(observed.count) ||
        observed.count <= requests.requests.length ||
        !(observed.next === null || observed.next === observed.count) ||
        typeof observed.requested !== "boolean"))
      throw Object.assign(new Error("Invalid close request wire window."), { checkpointIntegrity: true });
    if (!Number.isSafeInteger(earlier.count) || earlier.count < 0 || !Array.isArray(requests.requests) ||
        (observed?.count ?? requests.requests.length) < earlier.count)
      throw Object.assign(new Error("Close request snapshot integrity conflict."), { checkpointIntegrity: true });
    const outcome = selected.receipt.outcome;
    const variant = kind === "pause" && value.status !== "blocked" && ["sealed", "observed"].includes(outcome) &&
      (observed ? observed.next === null && !observed.requested :
        requests.next === null && !requests.requests.some(request => request.taskId === task.id)) ? outcome : null;
    if (baseline.variant !== variant || baseline.sealOutcome !== outcome || baseline.captured !== (variant !== null))
      throw Object.assign(new Error("Close next-baseline selection differs from workflow evidence."), { checkpointIntegrity: true });
    if (variant && (storeProjection?.head.seq !== transport.head?.seq ||
        storeProjection.P.prompt.execution?.checkpoint.key !== nextBaselines[variant].key))
      throw Object.assign(new Error("Close continuation reference integrity mismatch."), { checkpointIntegrity: true });
    if (savedReceipt && !same(currentCandidate, candidate(gate.receipt.after))) {
      const reason = "Current candidate differs from the saved close gate receipt; recovery required, gates must not be rerun.";
      loop.halt = { status: "blocked", code: "recovery", reason, ref: clone(descriptor.close.ref) };
      return save().then(() => { throw new Error(reason); });
    }
    currentCandidate = candidate(gate.receipt.after);
    loop.metricSeries = clone(gate.receipt.progress);
    invocation.currentView = clone(view);
    invocation.boardTopicId = invocation.currentView.topicId;
    delete transport.projection.view;
    return observeGroupedRequests(transport, true, requests).then(() => {
      descriptor.foldedNextBaseline = variant ? admitBaseline(nextBaselines[variant], baseline, transport.head) : null;
      if (committedInput) {
        descriptor.close.steps = transport.projection.steps.map(step => step.operation);
        descriptor.close.input = { operation: "close", root: config.root, invocation: config.invocation,
          key: descriptor.close.key, storeId: invocation.storeId,
          scope: `exec:${config.invocation}.e${invocation.epoch ?? 0}`,
          expectedHead: clone(transport.head), refs: { input: committedInput } };
      }
      return save();
    }).then(() => selected);
  });
}
const taskReviewFinding = object({
  summary: string, introducedByDelta: { type: "boolean" }, affectsTask: { type: "boolean" },
  evidence: string,
});
taskReviewFinding.properties.predatesTask = { type: "boolean" };
const TASK_REVIEW_FINDINGS_MAX = 8;
const taskReviewAnswer = object({
  verdict: string, score: { type: "integer", minimum: 0, maximum: 10 },
  findings: { type: "array", maxItems: TASK_REVIEW_FINDINGS_MAX, items: taskReviewFinding },
});
const taskReviewSchema = object({
  completeness: taskReviewAnswer, correctness: taskReviewAnswer, scope: taskReviewAnswer,
  conflict: { type: "boolean" },
});
Object.assign(taskReviewSchema.properties, {
  remaining: list(string), diagnosis: string, revival: string,
});
function taskReviewProjection(value, reference, carried) {
  const questions = ["completeness", "correctness", "scope"];
  const scores = {}, blocking = [], notes = [];
  for (const name of questions) {
    const answer = value?.[name];
    if (!Number.isInteger(answer?.score) || answer.score < 0 || answer.score > 10 ||
        !text(answer.verdict) || !Array.isArray(answer.findings) || answer.findings.length > TASK_REVIEW_FINDINGS_MAX ||
        answer.score < 10 && !answer.findings.length) throw new Error("Invalid anchored task review answer.");
    scores[name] = answer.score;
    for (const finding of answer.findings) {
      if (!text(finding.summary) || !text(finding.evidence) ||
          typeof finding.introducedByDelta !== "boolean" || typeof finding.affectsTask !== "boolean")
        throw new Error("Invalid task review finding.");
      (finding.introducedByDelta || finding.affectsTask || carried && finding.predatesTask !== true
        ? blocking : notes).push(retainedText(finding.summary, { units: 256, bytes: 768 }));
    }
  }
  if (typeof value.conflict !== "boolean") throw new Error("Invalid task review conflict.");
  return { scores, admitted: Object.values(scores).every(score => score >= 9) && !blocking.length && !value.conflict,
    blocking, conflict: value.conflict, notes: notes.length ? reference : null,
    ...(Array.isArray(value.remaining) && value.remaining.every(text)
      ? { remaining: value.remaining.slice(0, 4).map(item => retainedText(item, { units: 256, bytes: 768 })) } : {}),
    ...(text(value.diagnosis) ? { diagnosis: excerpt(value.diagnosis) } : {}),
    ...(text(value.revival) ? { revival: excerpt(value.revival) } : {}) };
}
function reviewProjection(reference) {
  if (!reference) return undefined;
  // Retained pre-deduplication intentions and ledger bodies keep their original bytes.
  const projection = reference.projection ?? frameProjection("reviewProjections", reference.key);
  if (!projection) throw new Error(`Missing task review projection: ${reference.key}.`);
  return projection;
}
function taskReviewRepair() {
  const repair = invocation.taskFrame?.reviewRepair;
  if (!repair || repair.blocking) return repair;
  const verdict = reviewProjection(repair.source);
  return { ...repair, blocking: verdict.blocking, remaining: verdict.remaining ?? verdict.blocking,
    diagnosis: verdict.diagnosis ?? "", revival: verdict.revival ?? "" };
}
function reviewTask(descriptor, task) {
  const review = descriptor.taskReview ??= {};
  if (descriptor.reviewRecovered && review.synthesis) return Promise.resolve();
  const originals = descriptor.reviewRecovered ? [] : [review.reviewer, review.synthesis].filter(Boolean);
  // Recheck published bytes on every re-entry; a cached decision is not an access receipt.
  const access = originals.length ? (() => {
    const prior = descriptor.taskReviewAccess;
    if (!prior || prior.stage === "receipt")
      descriptor.taskReviewAccess = { key: `${descriptor.key}.task-access.${(prior?.observation ?? 0) + 1}`,
        observation: (prior?.observation ?? 0) + 1, retry: 0, stage: "intention" };
    return loopIO("taskReviewAccess", { operation: "reviewOriginals",
      originals: originals.map(({ key, runId, path, digest }) => ({ id: key, key, runId, path, digest })) }, descriptor).then(() =>
      originals.reduce((previous, ref) => previous.then(() => {
        const call = loop.analysisCalls?.find(call => call.key === ref.key);
        if (!call) throw new Error(`Missing task review producer: ${ref.key}.`);
        return observeAnalysis(call, ref);
      }), Promise.resolve()));
  })() : Promise.resolve();
  descriptor.delta ??= { key: `${descriptor.key}.delta`, retry: 0, stage: "intention" };
  const intents = [...new Map([...(invocation.taskFrame.reviewIntents ?? []).map(frameIntent),
    ...(invocation.taskFrame.sources ?? []).map(frameIntent), descriptor.checkpoint]
    .map(intent => [intent.key, intent])).values()].sort((a, b) => a.attempt - b.attempt);
  return access.then(() => loopIO("delta", { operation: "taskDelta", root: config.root, invocation: config.invocation,
    requestObservation: invocation.requestObservation ?? 0, intents }, descriptor)).then(delta => {
    if (delta.unsettled === true) { review.unsettled = true; return; }
    if (!Array.isArray(delta.touched) || !Array.isArray(delta.netChanged) || delta.netChanged.length > 200 ||
        ![...delta.touched, ...delta.netChanged].every(text)) throw new Error("Invalid task delta evidence.");
    const diff = delta.diff;
    if (delta.touched.length ? !diff || typeof diff.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(diff.sha256) ||
        !/^[a-f0-9]{64}$/.test(diff.digest ?? "") || diff.store?.storeId !== invocation.storeId ||
        diff.store?.scope !== `exec:${config.invocation}.e${invocation.epoch ?? 0}` ||
        !Number.isSafeInteger(diff.store.seq) || diff.store.seq < 1 || diff.store.seq > invocation.head?.seq ||
        ![diff.bytes, diff.lines, diff.omitted].every(value => Number.isSafeInteger(value) && value >= 0) ||
        diff.lines < 1 : diff !== null) throw new Error("Invalid task delta evidence.");
    if (!delta.touched.length) return;
    const carried = !!task.remaining?.length || (task.progress?.last5?.length ?? 0) > 0 ||
      (task.progress?.nonImproving ?? 0) > 0;
    const brief = `Read-only per-task review. Read the complete immutable spec and its Scope and Exclusions:
${invocation.association.source} (SHA-256 ${invocation.association.digest}).
${fullContext()}
Frozen amendments: ${canonicalJSON(invocation.amendments ?? [])}.
Task definition: ${canonicalJSON(task)}.
Delta reference: ${canonicalJSON(diff)}.
a/ = slot baseline before attempt 1, b/ = current candidate.
Read the record with pitako_store (op: record, storeId, scope, seq); page it fully and match its digest.
Read body.patch using its index start lines. Missing or mismatched evidence is a blocking finding of uncertain provenance.
Non-rendered statuses are declared limits: do not claim to have reviewed unavailable bytes, and do not deduct for that alone.
git_diff and watchdog_diff compare with HEAD and include earlier loops' WIP.
The diff covers only this loop; for carried tasks, earlier-loop work is visible only in current source.
Changed-file evidence: ${canonicalJSON(delta)}.
Observed gate results (command definitions and status, exit, bounded tail, log reference):
${canonicalJSON({ definitions: task.gates, results: descriptor.gate.receipt.gates })}.
Unavailable checks are unobserved; do not deduct for that alone. carried: ${carried}.
Answer completeness against expectedResult (for corrections, every admitted finding path);
correctness against achieving the result without introducing failures; scope against goal,
specRefs and the spec Scope/Exclusions. Scope limits edit locations, not required outcomes.
Distinguish correctness from sufficiency; verify every required task outcome against current evidence.
For each question give a verdict, score 0-10, and concrete source-evidenced findings.
Return at most ${TASK_REVIEW_FINDINGS_MAX} findings per question. Above that cap, consolidate related findings
without dropping blocking outcomes or their evidence; cite complete originals for supporting detail.
Anchors: 10 = fully satisfied, no finding; 9 = satisfied with minor concrete non-blocking findings;
7-8 = material unmet outcome; 4-6 = major defects; 0-3 = absent or fundamentally wrong.
Every score below 10 requires a concrete finding. Every finding states introducedByDelta,
affectsTask (leaves goal or expectedResult undone), summary and evidence.
Inherited-only findings never block: prove they predate the task and do not affect its goal.
Uncertain provenance blocks; carried task defects affecting its result block regardless of origin.
For inherited findings set predatesTask true only with concrete evidence they predate the task;
otherwise set it false. On rejection provide remaining, diagnosis and revival for the repair.
Prior blocking findings and synthesis original: ${canonicalJSON(taskReviewRepair() ?? null)}.
When repairing, review the whole slot delta and verify every prior blocking finding is closed.
Report conflict when expectedResult requires a spec exclusion. No unrelated improvements.
Finish with structured_output.`;
    return ["reviewer", "synthesis"].reduce((previous, stage) => previous.then(() => {
      const childKey = `${generationKey(descriptor.key, `task-${stage}`)}.task-${stage}`;
      if (review[stage]) return;
      const prior = stage === "synthesis" ? review.reviewer : null;
      return analysisDispatch([{ key: childKey, agent: pitakoReviewerAgent(childKey), context: "fresh",
        cwd: config.root, label: `Task ${stage}: ${task.id}`, phase: `task-${stage}`,
        model: invocation[stage === "reviewer" ? "taskReviewer" : "taskSynthesis"],
        output: `${childKey}.json`, outputMode: "file-only", reads: false, progress: false,
        skill: ["verify-behavior", "ponytail", "ponytail-review", "rust-best-practices", "rust-review", "scope-discipline"], outputSchema: taskReviewSchema,
        task: brief + (prior ? `\nStrict synthesis: read the reviewer original by path ${prior.path}
(canonical digest ${prior.digest}); re-check every finding against source and rescore independently.
Admit only if all three scores >=9 and no introduced or task-outcome finding blocks.` : ""),
      }]).then(([result]) => {
        if (!result?.ok || !result.structuredOutput) {
          loop.halt = taskReviewModelHalt(childKey, result, invocation);
          return save().then(() => { throw new Error(loop.halt.reason); });
        }
        const path = result.results?.find(item => text(item.savedOutputPath) && !item.outputSaveError)?.savedOutputPath;
        if (!path || !text(result.runId)) throw new Error("Task review original was not published.");
        const body = clone(result.structuredOutput);
        const reference = { key: childKey, runId: result.runId, path, digest: canonicalDigest(body) };
        const projection = taskReviewProjection(body, reference, carried);
        (invocation.taskFrame.reviewProjections ??= {})[childKey] = projection;
        review[stage] = reference;
        if (stage === "synthesis" && !projection.admitted) {
          const repair = invocation.taskFrame.reviewRepair;
          invocation.taskFrame.reviewRepair = { ...(repair?.attempt ? { attempt: repair.attempt } : {}), source: reference,
            exhausted: !!repair?.attempt || projection.conflict };
        }
        return save();
      });
    }), Promise.resolve());
  });
}
function checkpointIntegrityHalt(observed, ref) {
  return { status: "blocked", code: "checkpoint-integrity", reason: checkpointMismatchReason(observed.paths),
    ref: { key: ref.key, runId: ref.runId, agent: ref.agent }, originalDigest: canonicalDigest(clone(observed)) };
}
// Only the active root can turn the settled result and its saved gates into a seal.
function sealAndAdmit(result, descriptor, task, recoveryRef, statusRef) {
  if (loop.attempt.stage === "result") throw new Error("Duplicate attempt admission rejected.");
  // Replay must check the observed native reference before any close or review.
  let structural;
  try { structural = workerValue(result, descriptor, task, statusRef); } catch (error) {
    if (!error?.reportRejection) throw error;
    structural = { rejection: String(error.message) };
  }
  if (!structural.rejection && !descriptor.launch) descriptor.launch = nativeReference(descriptor.key, result);
  let groupedSeal = descriptor.recoveredSeal;
  const complete = !structural.rejection && !recoveryRef && structural.value.status === "complete";
  return (descriptor.close?.receipt?.projection
    ? closeAttempt(descriptor, task, structural.value).then(receipt => { groupedSeal = receipt; })
    : complete ? verifyAttempt(descriptor, task, structural.value).then(receipt => {
    const passed = !receipt.mutated && (task.gates ?? task.checks).every(gate =>
      receipt.gates.some(result => result.id === gate.id && result.status === "pass"));
    return passed ? reviewTask(descriptor, task) : undefined;
  }).then(() => {
    // Ineligible attempts retain the grouped close, including its request observation.
    if (!descriptor.taskReview?.synthesis && !descriptor.taskReview?.unsettled && !descriptor.seal)
      return closeAttempt(descriptor, task, structural.value).then(receipt => { groupedSeal = receipt; });
    return (descriptor.recoveredRequests
      ? admitRequests(descriptor.recoveredRequests, 0, [], true)
      : observeMainRequests(0, [], true)).then(() => {
      if (invocation.intentions?.length) return groupedIO("finishDrain", { operation: "drain" }, invocation);
    });
  }) : !structural.rejection && !recoveryRef && !descriptor.gate && !descriptor.seal
    ? closeAttempt(descriptor, task, structural.value).then(receipt => { groupedSeal = receipt; })
    : !structural.rejection && !recoveryRef ? verifyAttempt(loop.attempt, task, structural.value) : Promise.resolve()).then(() => {
  descriptor.gate = loop.attempt.gate;
  const receipt = descriptor.gate?.receipt;
  const definitions = task.gates ?? task.checks;
  const passed = receipt && !receipt.mutated && receipt.gates.length === definitions.length &&
    definitions.every(gate => receipt.gates.some(result => result.id === gate.id && result.status === "pass"));
  const admittedReview = reviewProjection(descriptor.taskReview?.synthesis);
  const repair = invocation.taskFrame.reviewRepair;
  if (repair?.attempt && (structural.rejection || structural.value.status !== "complete" ||
      !passed || admittedReview?.admitted === false)) repair.exhausted = true;
  const kind = recoveryRef || structural.rejection ? null :
    structural.value.status === "complete" && passed && admittedReview?.admitted !== false ? "unit" : "pause";
  const pending = loop.attempt.seal ??= { retry: 0, kind };
  if (pending.kind !== kind) throw new Error("Saved seal kind differs from its gate receipt; recovery required.");
  const reusedSealer = descriptor.taskReview?.synthesis && settledTaskSealer?.key === sealerKey(descriptor.key, pending.retry - 1)
    ? settledTaskSealer : null;
  const intent = descriptor.checkpoint;
  if (!intent) throw new Error("Missing checkpoint intention for root observation.");
  let ref;
  settledTaskSealer = null;
  function runSealer(retry) {
    const sealKey = sealerKey(descriptor.key, retry);
    ref = groupedSeal ? clone(descriptor.recoveryRef ?? descriptor.close.ref) : { key: sealKey, agent: "pitako.checkpoint-sealer" };
    pending.retry = retry + 1;
    return (groupedSeal ? save().then(() => []) : reusedSealer ? Promise.resolve([reusedSealer.result]) :
      save().then(() => dispatch([{ key: sealKey, agent: "pitako.checkpoint-sealer",
        task: canonicalJSON({ v: 1, intent, kind,
          ...(descriptor.restore ? { restoreSources: descriptor.restore.sourceKeys.map(sourceKey => {
            const source = frameIntent(sourceKey);
            if (!source) throw new Error("Missing authenticated restoration source intent.");
            return source;
          }) } : {}) }), cwd: config.root, context: "fresh", output: false, outputMode: "inline",
        outputSchema: false, reads: false, progress: false }]))).then(([sealed]) => {
      if (!groupedSeal) {
        ref = { ...nativeReference(sealKey, sealed), agent: "pitako.checkpoint-sealer" };
        const cause = barrier(sealed, sealKey);
        if (cause) throw nativeBarrier(cause, ref, sealed);
      }
      const failures = [sealed, ...(sealed?.results ?? [])].filter(Boolean);
      if (!groupedSeal && (!sealed?.ok || sealed.agent !== "pitako.checkpoint-sealer" || !text(sealed.runId) ||
          sealed.key !== undefined && sealed.key !== sealKey || sealed.state !== undefined || sealed.terminalOutcome ||
          !text(sealed.asyncDir) || !text(sealed.externalAdapter?.outputArtifacts?.stdoutPath) ||
          !text(sealed.externalAdapter?.outputArtifacts?.stderrPath) ||
          !Array.isArray(sealed.results) || sealed.results.length !== 1 || sealed.results[0].exitCode !== 0 ||
          failures.some(item => item.error || item.outputSaveError || item.metadataSaveError || item.transcriptError ||
            item.outputPartial || item.truncation || item.timedOut || item.processSignal ||
            item.exitCode !== undefined && item.exitCode !== 0)))
        throw nativeBarrier("Checkpoint sealer lacks successful terminal stdout.", ref);
      let observed = groupedSeal?.receipt;
      if (typeof sealed?.output === "string" && utf8Bytes(sealed.output) <= 61440) {
        try { observed = JSON.parse(sealed.output); } catch (_) { /* Invalid stdout is a barrier, not evidence. */ }
      }
      if (!groupedSeal && text(observed?.code) && text(observed.reason) &&
          ["code,reason", "code,reason,recovery"].includes(Object.keys(observed).sort().join(","))) {
        const failure = Object.assign(new Error(observed.reason), { code: observed.code, recovery: observed.recovery });
        if (!failure.recovery && ["store-corrupt", "cursor-ahead", "store-unavailable", "store-replaced"].includes(failure.code)) {
          // The sealer's intent reader cannot quarantine; recheck the saved head with the existing writer.
          const cursor = executeCursor(), opKey = `${sealKey}.store-check`;
          return checkEpochProducers().then(() => replayLoopIO(opKey, {
            operation: "verifySelection", key: opKey, root: cursor.root, invocation: cursor.invocation,
            storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead: cursor.head,
          })).then(() => { throw failure; });
        }
        throw failure;
      }
      if (!observed || observed.v !== 1 || observed.kind !== kind)
        throw nativeBarrier("Checkpoint sealer lacks successful terminal stdout.", ref);
      if (!groupedSeal && observed.outcome === "store-busy" && Object.keys(observed).sort().join(",") === "kind,outcome,v") {
        if (retry < 2) return runSealer(retry + 1);
        throw Object.assign(new Error("Checkpoint sealer store remained busy."), { code: "store-busy" });
      }
      if (!["sealed", "observed", "mismatch", "open"].includes(observed.outcome))
        throw nativeBarrier("Checkpoint sealer lacks successful terminal stdout.", ref);
      return observed;
    });
  }
  return runSealer(reusedSealer ? pending.retry - 1 : pending.retry).then(observed => {
    candidate(observed.candidate);
    if (receipt && !same(candidate(observed.candidate), candidate(receipt.after))) {
      const reason = "Sealer candidate differs from the saved gate receipt; recovery required, gates must not be rerun.";
      loop.halt = { status: "blocked", code: "recovery", reason, ref };
      return save().then(() => { throw new Error(reason); });
    }
    if (observed.capturedPaths !== undefined &&
        (!Number.isSafeInteger(observed.capturedPaths) || observed.capturedPaths < 0))
      throw nativeBarrier("Invalid captured path count.", ref);
    const fields = Object.keys(observed).filter(field => field !== "capturedPaths").sort().join(",");
    const baseFields = "candidate,kind,outcome,v";
    if (observed.outcome === "open") {
      if (fields !== "candidate,kind,outcome,paths,v" || !Array.isArray(observed.paths) ||
          !observed.paths.length || observed.paths.length > 10 || !observed.paths.every(text))
        throw nativeBarrier("Invalid never-closed checkpoint effect observation.", ref);
      return checkpointFallback(result, nativeReference(descriptor.key, result), task);
    }
    if (observed.outcome === "mismatch") {
      if (fields !== "candidate,kind,outcome,paths,v" || !Array.isArray(observed.paths) ||
          !observed.paths.length || observed.paths.length > 10 || observed.paths.some(entry =>
            !same(Object.keys(entry).sort(), ["actual", "journaled", "partiallyApplied", "path"]) || !text(entry.path) ||
            ![entry.actual, entry.journaled].every(hash => hash === null || /^[a-f0-9]{64}$/.test(hash)) ||
            typeof entry.partiallyApplied !== "boolean"))
        throw nativeBarrier("Invalid checkpoint mismatch observation.", ref);
      const producer = groupedSeal ? descriptor.close?.ref : ref;
      loop.halt = checkpointIntegrityHalt(observed, producer ?? ref);
      if (text(producer?.runId))
        inFlight.set(producer.key, { key: producer.key, runId: producer.runId,
          role: groupedSeal ? "loop-io" : "checkpoint-sealer" });
      const reason = loop.halt.reason;
      // A repaired candidate must be re-observed, not reuse the failed grouped seal.
      if (groupedSeal) {
        descriptor.close.receipt = receiptReference(descriptor.close.receipt);
        delete descriptor.close.input;
      }
      return save().then(() => { throw Object.assign(new Error(reason), { checkpointIntegrity: true }); });
    }
    if (observed.outcome === "sealed") {
      if (kind === null || fields !== (observed.restored ? "candidate,checkpointRef,digest,kind,outcome,position,restored,v" : "candidate,checkpointRef,digest,kind,outcome,position,v") ||
          observed.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${intent.key}/${kind}.json` ||
          !/^[a-f0-9]{64}$/.test(observed.digest ?? "") || !same(observed.position,
            { loop: intent.loop, cursor: intent.cursor + (kind === "unit" ? 1 : 0), phase: intent.phase }))
        throw nativeBarrier("Invalid checkpoint seal receipt.", ref);
    } else if (fields !== baseFields && fields !== "candidate,kind,outcome,restored,v")
      throw nativeBarrier("Invalid checkpoint candidate observation.", ref);
    if (observed.restored) {
      const receipt = observed.restored, restore = descriptor.restore;
      const directory = receipt.checkpointRef?.replace(/\/manifest\.json$/, "");
      const allowed = restore && [...restore.sourceKeys.map(key => `${config.root}/.pi/subagents/checkpoints/${key}`),
        ...(restore.authority.confirmedUnit ? [restore.authority.confirmedUnit.checkpointRef.replace(/\/unit\.json$/, "")] : [])];
      const confirmed = field => restore?.authority[field]?.checkpointRef === `${directory}/${field === "confirmedPause" ? "pause" : "unit"}.json` ? {
        checkpointRef: restore.authority[field].checkpointRef, digest: restore.authority[field].digest,
      } : undefined;
      candidate(receipt.candidate);
      if (!allowed?.includes(directory) || receipt.partialRef !== `${directory}/restore.json` ||
          receipt.restoredRef !== `${directory}/restored.json` || !/^[a-f0-9]{64}$/.test(receipt.digest ?? "") ||
          !same(receipt.position, { loop: intent.loop, cursor: intent.cursor, phase: intent.phase }) ||
          !same(receipt.confirmedPause, confirmed("confirmedPause")) ||
          !same(receipt.confirmedUnit, confirmed("confirmedUnit")))
        throw nativeBarrier("Invalid checkpoint restoration observation.", ref);
    }
    const settled = !groupedSeal && !reusedSealer && descriptor.taskReview?.synthesis && text(ref.runId);
    if (settled) inFlight.set(ref.key, { key: ref.key, role: "checkpoint-sealer", runId: ref.runId });
    return (settled ? save() : Promise.resolve()).then(() => {
      const admitted = admitWorker(result, descriptor, task, recoveryRef, statusRef, observed, structural.rejection ? structural : undefined);
      for (const [key, child] of inFlight)
        if (child.role === "checkpoint-sealer" && key.startsWith(`${descriptor.key}.seal`))
          inFlight.delete(key);
      if (groupedSeal && descriptor.close) {
        descriptor.close.receipt = receiptReference(descriptor.close.receipt);
        delete descriptor.close.input;
      }
      return save().then(() => admitted);
    });
  }).catch(error => {
    if (error.spawnBudgetExhausted) { pending.retry--; throw error; }
    if (error.nativeBarrier) {
      loop.halt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
        code: "native-barrier", cause: error.nativeBarrier, reason: String(error.message),
        ref: clone(error.nativeReference ?? ref) };
      return save().then(() => { throw error; });
    }
    throw error;
  });
  });
}
// A pending seal contains only frozen, persisted material; reentry diagnostics never enter its bytes.
function archiveProjection(value) {
  return JSON.parse(JSON.stringify(value, (name, child) =>
    ["halt", "interruption", "interruptions", "currentBarrier", "hostHalt", "failedHostObservation"].includes(name) ? undefined : child));
}
function sealRecord(projected) {
  const frame = clone(invocation.taskFrame);
  const pending = [invocation.sealPending?.record,
    ...(invocation.intentions ?? []).filter(entry => entry.operation === "ledger").map(entry => entry.input.record)];
  for (const collection of ["reviewProjections", "workerKnowledge"]) {
    const sources = pending.filter(record => record?.kind === "unit" && record.body.taskId === projected.taskId)
      .map(record => record.body.frame?.[collection]).filter(Boolean);
    if (frame[collection]) sources.push(frame[collection]);
    if (sources.length) frame[collection] = Object.assign({}, ...sources);
  }
  return { kind: "unit", loop: loop.number,
    body: archiveProjection({ taskId: projected.taskId, attempt: projected.attempt, result: clone(projected),
      // `result` is this attempt. An earlier result confirmed by its own seal is
      // already that unit record's result, so it is cited; an unsealed one is archived here.
      results: clone(loopResults().filter(item => item.taskId === projected.taskId && item.attempt !== projected.attempt)
        .map(item => item.checkpoint?.confirmation ? { taskId: item.taskId, attempt: item.attempt, status: item.status,
          sealed: { key: item.ref.key, digest: item.checkpoint.confirmation.digest } } : item)),
      frame, recoveries: clone(loop.recoveries),
      checkpoint: clone(invocation.lastConfirmed) }) };
}
function prepareSeal(projected) {
  invocation.sealPending = { expected: clone(invocation.ledger), record: sealRecord(projected) };
  // The frozen unit owns these bodies until admission; live consumers cite it.
  delete invocation.taskFrame.reviewProjections;
  delete invocation.taskFrame.workerKnowledge;
}
function loopResults(strict = true) {
  return loop.results.map(entry => {
    if (entry.ref) return entry;
    const task = invocation.tasks[entry.taskId];
    const result = [task?.completed, task?.last].find(value => value?.attempt === entry.attempt);
    if (!result) {
      if (!strict) return entry; // Reports retain the actual diagnosis for corrupt state.
      throw new Error(`Prerequisite ${entry.taskId} has no unique durable completed attempt; no dependent writer dispatched.`);
    }
    return result;
  });
}
function reportResult(result) {
  const fields = ["taskId", "attempt", "status", "ref", "workDone", "remaining", "remainingCount",
    "diagnosis", "candidate", "checks"];
  return {
    ...Object.fromEntries(fields.filter(field => result[field] !== undefined).map(field => [field, result[field]])),
    ...(result.taskReview ? { taskReview: Object.fromEntries(["reviewer", "synthesis"]
      .filter(stage => result.taskReview[stage])
      .map(stage => [stage, Object.fromEntries(["key", "runId", "path", "digest"]
        .map(field => [field, result.taskReview[stage][field]]))])) } : {}),
  };
}
function sealedResult(result) {
  return { ...reportResult(result), checkpoint: result.checkpoint, sealed: result.sealed };
}
// Only a verified ledger admission makes the dropped result fields durable.
function compactSealedAttempts(body) {
  // Published projections remain in that unit record; only live verdict/repair inputs stay here.
  const live = [invocation.taskFrame?.reviewRepair?.source?.key,
    ...Object.values(loop.attempt?.taskReview ?? {}).map(ref => ref?.key)];
  const liveKnowledge = [loop.attempt?.result?.knowledge?.key,
    ...Object.values(invocation.tasks).map(task => task.last?.knowledge?.key)];
  if (invocation.taskFrame) {
    for (const [collection, keys] of [["reviewProjections", live], ["workerKnowledge", liveKnowledge]]) {
      const projections = invocation.taskFrame[collection] ??= {};
      for (const [projectionKey, projection] of Object.entries(body.frame?.[collection] ?? {})) {
        if (keys.includes(projectionKey)) projections[projectionKey] ??= clone(projection);
        else delete projections[projectionKey];
      }
    }
  }
  // Frozen archives rebuild these exact result bytes until loop-ledger admission.
  if (loop.archivePending || loop.archiveQueued) return;
  const sealed = [body.result, ...(body.results ?? [])];
  loop.results = loopResults().map((entry, index) => {
    const published = sealed.find(result => result.taskId === entry.taskId && result.attempt === entry.attempt);
    const digest = published?.sealed?.digest ?? published?.checkpoint?.confirmation?.digest;
    if (!digest || !entry.checkpoint?.confirmation) return loop.results[index];
    return entry.taskId === loop.attempt?.taskId && entry.attempt === loop.attempt?.number
      ? loop.results[index] : sealedResult({ ...entry, sealed: { key: entry.ref.key, digest } });
  });
}
function bodyIdentity(body) {
  const encoded = JSON.stringify(body);
  let hash = 2166136261;
  for (let index = 0; index < encoded.length; index++) hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619);
  return `${encoded.length}:${hash >>> 0}`; // Programming invariant, not ledger authentication.
}
function closingRecord() {
  if (loop.closingSeed) {
    const record = closingArchive(loop.closingSeed, loop.compliance, loop.complianceUsage);
    if (loop.archivePending && bodyIdentity(record.body) !== loop.archivePending.bodyIdentity)
      throw new Error("Closing archive source fields changed before publication.");
    return record;
  }
  const pending = loop.archivePending;
  const record = loopArchive(pending.frozen).record;
  if (bodyIdentity(record.body) !== pending.bodyIdentity)
    throw new Error("Closing archive source fields changed before publication.");
  return record;
}
// A pending loop archive keeps its identity and the inputs that may still change,
// not a second copy of the frozen loop; publication rebuilds identical bytes.
function frozenLoopArchive(freezeScope) {
  const pending = loop.closingSeed ? { expected: clone(loop.closingSeed.expected), record: closingRecord() } : loopArchive();
  pending.bodyIdentity = bodyIdentity(pending.record.body);
  pending.frozen = { usage: clone(loop.usage), ...(freezeScope ? { cancelledScope: clone(cancelledScope()) } : {}) };
  delete pending.record.body;
  return pending;
}
function frozenLoopRecord(number, archive) {
  const record = loopArchive(archive.frozen).record;
  if (record.loop !== number || loop.archived || bodyIdentity(record.body) !== archive.bodyIdentity)
    throw new Error(`Loop ${number} archive source fields changed before publication; inspect the retained loop, no replacement record.`);
  return record;
}
function committedLoopOpen(number, projection = storeProjection?.P) {
  const opened = projection?.prompt.loopOpen;
  return opened?.number === number ? opened.startedAt : undefined;
}
function loopArchive(frozen) {
  const body = {};
  for (const field of ["number", "cursor", "manifest", "plan", "attempt", "results",
    ...(loop.kind === "final" ? ["kind", "startedAt", "acceptance", "acceptanceHistory", "finalAttempt"] : []),
    "recoveries", "analysisCalls", "review", "integratedReview", "compliance", "candidate", "usage", "retired", "analysisGenerations"]) {
    const value = field === "results" ? loopResults()
      : field === "analysisCalls" ? loop.analysisCalls?.map(call =>
        /\.task-(?:reviewer|synthesis)$/.test(call.key) && call.stage === "receipt" && call.ref.runId
          // The unit links the exact originals. Debug paths and observation-only
          // metadata from native status must not alter replayed archive bytes.
          ? { key: call.key, stage: call.stage, ref: { key: call.key, agent: call.ref.agent, runId: call.ref.runId } }
          : call)
      : field === "startedAt" ? committedLoopOpen(loop.number)
      : frozen && field === "usage" ? frozen[field] : loop[field];
    if (field === "startedAt" && value === undefined)
      throw new Error("Final archive lacks a committed loop-open time.");
    if (value !== undefined) body[field] = archiveProjection(value);
  }
  const scope = frozen?.cancelledScope ?? cancelledScope();
  if (scope.length) body.cancelledScope = clone(scope);
  return { expected: clone(invocation.ledger), record: { kind: "loop", loop: loop.number, body } };
}
function historyReference() {
  return { ledgerPath: `${config.root}/.pi/subagents/execute/${config.invocation}`, head: invocation.ledger.head };
}
function validSummaries(values, number = loop.number) {
  return Array.isArray(values) && values.length > 0 && values.length <= 3 &&
    values.every((value, index) => value && Object.keys(value).sort().join(",") === "compliance,gaps,loop,rejection,review,status" &&
      Number.isSafeInteger(value.loop) && value.loop > 0 && value.loop <= number &&
      (!index || values[index - 1].loop < value.loop) && ["complete", "gaps"].includes(value.status) &&
      ["gaps", "review", "compliance", "rejection"].every(field => typeof value[field] === "string" && value[field].length <= 1100)) &&
    values.at(-1).loop === number;
}
function foldLoop(summaries) {
  const sources = loopDemandSources();
  // Replace the previous loop's pending sources; generic gaps are not inherited demands.
  invocation.demandSources = [...(invocation.demandSources ?? []).filter(item => item.loop !== loop.number),
    ...(sources.length ? [{ loop: loop.number, sources }] : [])];
  retainDemandSources(loop.number);
  invocation.loopSummaries = summaries;
  invocation.planRejections = [...invocation.planRejections.filter(item => item.loop !== loop.number),
    { loop: loop.number, diagnostic: loop.plan?.rejection?.diagnostic ?? null }].slice(-3);
  const ref = loop.closing?.ref;
  invocation.closeReferences = [...invocation.closeReferences.filter(item => item.loop !== loop.number),
    { loop: loop.number, ...(ref ? { runId: ref.runId, asyncDir: ref.asyncDir,
      stdoutPath: ref.externalAdapter.outputArtifacts.stdoutPath, stderrPath: ref.externalAdapter.outputArtifacts.stderrPath } : {}) }].slice(-3);
  foldUsage();
  delete loop.analysisCalls;
  loop.recoveries = [];
}
function loopDemandSources() {
  const sources = [];
  const exit = loop.manifest && loop.cursor < loop.manifest.length ? loopResults().at(-1) : null;
  if (exit?.ok && ["gaps", "continue"].includes(exit.status))
    sources.push({ kind: "worker", ref: exit.ref, taskId: exit.taskId, attempt: exit.attempt,
      status: exit.status, diagnosis: excerpt(exit.diagnosis) });
  if (loop.review?.verdict === "material-gaps")
    sources.push({ kind: "review", ref: loop.reviewSynthesis, reason: excerpt(loop.review.reason) });
  if (loop.compliance?.status === "gaps")
    sources.push({ kind: "compliance", ref: loop.compliance.ref, reason: excerpt(loop.compliance.reason) });
  return sources;
}
function archiveGaps() {
  if (loop.archived || loop.archiveQueued) return Promise.resolve();
  const pending = loop.archivePending ??= frozenLoopArchive(true);
  if (!invocation.intentions?.some(entry => entry.operation === "ledger")) pending.expected = clone(invocation.ledger);
  return archiveSeal(pending);
}
function archiveSeal(pending = invocation.sealPending) {
  queueSeal(pending);
  return save();
}
function queueSeal(pending) {
  const closing = pending.record.kind === "loop";
  const previous = invocation.intentions?.findLast(entry => entry.operation === "ledger");
  const sealKey = `${key}.l${pending.record.loop}.${closing ? "gaps" : `seal${Math.max(1, pending.expected.count)}`}`;
  // The admitted spec is cited by digest; the drain transports its exact content.
  const input = { expected: clone(pending.expected), record: clone(pending.record),
    ...(pending.expected.count === 0 && !previous ? { spec: { digest: invocation.association.digest } } : {}) };
  if (previous) { input.expectedFrom = previous.key; delete input.expected; }
  const archive = closing && !pending.record.body ? { bodyIdentity: pending.bodyIdentity, frozen: clone(pending.frozen) } : null;
  if (archive) frozenLoopRecord(pending.record.loop, archive);
  queueIntention({ key: sealKey, operation: "ledger", input, ...(archive ? { archive } : {}) });
  if (closing) {
    loop.archiveQueued = true;
    loop.archivePending = { expected: clone(pending.expected),
      record: { kind: pending.record.kind, loop: pending.record.loop }, intentionKey: sealKey };
  } else {
    invocation.sealPending = null;
    loop.recoveries = [];
    if (pending.record.body.result.status === "complete") {
      invocation.taskFrame = null;
      delete loop.interruptions;
      delete loop.attempt.pauseSource;
      delete loop.attempt.restore;
    }
  }
}
function validLoopAnchor(anchor, count = Math.max(1, loop.archivePending.expected.count) + 1) {
  return anchor && Object.keys(anchor).sort().join(",") === "count,head" &&
    Number.isSafeInteger(anchor.count) && anchor.count >= 2 && anchor.count === count &&
    /^[a-f0-9]{64}$/.test(anchor.head ?? "");
}
function confirmedPausePending() {
  const result = loop?.attempt?.stage === "result" && loop.attempt.result;
  const { taskId, attempt, resultRef, ...receipt } = invocation?.lastConfirmed ?? {};
  return loop?.phase === "implementation" && ["blocked", "continue", "gaps"].includes(result?.status) && result.remainingCount > 0 &&
    result.checkpoint?.confirmation?.kind === "pause" && taskId === result.taskId && attempt === result.attempt &&
    same(resultRef, result.ref) && same(receipt, result.checkpoint.confirmation);
}
// A blocked writer's close seals a pause whenever it captured paths, and that
// seal is this result's confirmation. Without either, the block wrote nothing.
function retainWorkerBlock(result) {
  loop.outcome = "blocked";
  loop.halt = { status: "blocked", code: "semantic-block", reason: result.diagnosis, ref: result.ref };
}
function loopReport(status, reason) {
  emitTodoSnapshot();
  const now = Date.now();
  const last = loopResults(false).at(-1);
  const stale = !!loop.invalidated || loop.closing?.sameCandidate === false;
  if (persistenceFailed && persistenceReason && !reason.includes(persistenceReason)) reason += ` ${persistenceReason}`;
  const exhausted = !persistenceFailed && !loop.halt && status === "gaps" && invocation.consumedLoops >= maxCycles();
  if (exhausted) reason = `${maxCycles()} authorized loops consumed; execution partial. Remaining work requires a new invocation with human authorization.` +
    (stale ? " Candidate changed; affected checks and analyses are stale." : "");
  const report = {
    type: "execution-loop", invocation: config.invocation, loop: loop.number, maxLoops: maxCycles(),
    status: exhausted ? "partial" : status, reason, phase: loop.phase, candidate: loop.closing?.candidate ?? last?.candidate ?? null,
    boardTopicId: invocation?.boardTopicId ?? null,
    timeouts: timeoutReport(),
    cancelledScope: cancelledScope(), originalProblem: originalProblem(),
    halt: loop.halt ?? null, history: { summaries: invocation.loopSummaries, ...historyReference() },
    elapsedMs: (loop.endedAt ?? now) - loop.startedAt, totalElapsedMs: now - invocation.startedAt,
    tokens: metrics(loop), totalTokens: metrics(),
    work: loopResults(false).map(result => ({ taskId: result.taskId, attempt: result.attempt,
      status: result.status, reference: result.ref, workDone: result.workDone ?? "See native failure result",
      remaining: result.remaining ?? [], remainingCount: result.remainingCount ?? null,
      diagnosis: result.diagnosis ?? "See native failure result" })),
    verification: {
      checks: loopResults(false).filter(result => result.checks).map(result => ({
        taskId: result.taskId, ...result.checks, current: result.checks.current && !stale,
        status: stale ? "stale" : result.checks.current ? "passed" : "failed-or-not-run", reference: result.ref,
      })),
      adversarial: loop.review ? { ...loop.review, status: stale ? "stale" : loop.review.status,
        observedStatus: loop.review.status } : { status: "not-run" },
      compliance: loop.compliance ? { ...loop.compliance, status: stale ? "stale" : loop.compliance.status,
        observedStatus: loop.compliance.status } : { status: "not-run" },
    },
    pending: status === "complete" ? [] : [{ reason, remaining: last?.remaining ?? [],
      diagnosis: last?.diagnosis ?? loop.plan?.rejection?.diagnostic ?? null, references: [
      last?.ref, loop.review?.references, loop.compliance?.ref, loop.halt?.ref, loop.plan?.rejection?.ref,
      ...(loop.analysisCalls ?? []).map(call => call.ref),
    ].filter(Boolean) }],
    next: status === "budget-exhausted" ? "automatically relaunch the same invocation and mission as a new top-level run"
      : loop.halt ? (persistenceFailed ? "restore essential persistence; resolve observed impediment before any continuation" : "resolve observed impediment") : persistenceFailed ? "restore essential persistence; continuation requires supported native reconciliation" : status === "complete" ? "close" : status === "gaps" && invocation.consumedLoops < maxCycles()
      ? `continue loop ${loop.number + 1}` : status === "gaps" ? "new invocation requires human authorization" : "resolve observed impediment",
    actionRequired: !persistenceFailed && !loop.halt && (["complete", "budget-exhausted"].includes(status) || (status === "gaps" && invocation.consumedLoops < maxCycles())) ? "none" : reason,
    action: action(exhausted ? "partial" : status, reason),
  };
  if (typeof emit === "function") emit(report);
  return report;
}
function action(status, reason) {
  if (status === "budget-exhausted") return { actor: "foreground", operation: "relaunch the same invocation and mission as a new top-level run",
    reason, references: [], started: false };
  if (loop?.halt?.code === "needs-decision") return { actor: "human",
    operation: "post the ruling as Board HUMAN and start a new invocation on the same worktree and backlog", reason, references: [], started: false };
  if (loop?.halt?.code === "spawn-budget") return { actor: "human",
    operation: "raise config.maxSubagentSpawnsPerRun or reduce the step's spawn demand, then start a new invocation", reason, references: [], started: false };
  const required = status !== "complete";
  const exhausted = !persistenceFailed && !loop?.halt && status === "partial" &&
    invocation?.consumedLoops >= maxCycles();
  const coordinatorHalt = !persistenceFailed && !hostHalt &&
    reason === loop?.halt?.reason && loop?.halt?.code === "timeout";
  return {
    actor: !required ? "none" : persistenceFailed ? "persistence operator" : exhausted ? "human"
      : hostHalt ? "native run operator"
      : coordinatorHalt ? "foreground"
      : loop?.halt?.code === "recovery" ? "evidence owner"
      : loop?.halt?.code === "semantic-block" ? "task owner"
      : loop?.halt ? "native run operator" : "active root",
    operation: !required ? "close" : persistenceFailed ? "restore essential persistence; no dispatch authorized"
      : hostHalt ? "continue only in a new invocation"
      : exhausted ? "authorize a new invocation"
      : coordinatorHalt ? loop.halt.reason
      : loop?.halt ? "resolve the concrete retained impediment; no replacement dispatch"
      : "perform the next existing phase under native authority",
    reason, references: [hostHalt?.ref, loop?.halt?.ref, loop?.recoveries?.at(-1)?.ref,
      loop?.observation?.ref, loop?.attempt?.launch, loop?.plan?.ref, ...(loop?.analysisCalls ?? []).map(call => call.ref)].filter(Boolean),
    // This describes pending work, not a claim that a root was resumed.
    started: false,
  };
}
function canSaveBudgetExhaustion(error) {
  return error?.spawnBudgetExhausted && invocation?.association && !persistenceFailed && !loop?.halt &&
    !hostHalt;
}
function spawnBudgetHalt(lastProgress) {
  return { status: "blocked", code: "spawn-budget", lastProgress,
    reason: "No seals admitted or loops closed since the previous budget-exhausted end; one step needs more spawns than the per-run budget. Human intervention must raise config.maxSubagentSpawnsPerRun or reduce that step's spawn demand." };
}
function finishBudgetExhaustion() {
  const marker = { checkpoint: invocation.lastConfirmed?.digest ?? null,
    closedLoop: loop?.archived ? loop.number : (loop?.number ?? 1) - 1,
    ledger: clone(invocation.ledger), backlogDigest: invocation.backlogDigest ?? null,
    taskReview: loop?.attempt ? {
      key: loop.attempt.key, worker: loop.attempt.launch?.runId ?? null,
      gate: loop.attempt.gate?.stage === "receipt" ? loop.attempt.gate.key : null,
      delta: loop.attempt.delta?.stage === "receipt" ? loop.attempt.delta.key : null,
      analyses: (loop.analysisCalls ?? []).filter(call => /\.task-(reviewer|synthesis)$/.test(call.key) &&
        call.stage === "receipt" && call.ref.runId).map(call => call.ref.runId),
    } : null };
  const progress = canonicalDigest(marker);
  const stalled = progress === invocation.lastBudgetProgress;
  invocation.lastBudgetProgress = progress;
  if (stalled) loop.halt = spawnBudgetHalt(progress);
  return save(true).then(() => finish(stalled ? "blocked" : "budget-exhausted", stalled ? loop.halt.reason :
    "Native per-run spawn budget exhausted before any child in the admission group started; state saved. Automatically relaunch the same invocation and mission as a new top-level run.", true));
}
function finish(status, reason, drained = false) {
  // Early blocks before admission validation promise no dispatch: retained intentions stay unchanged.
  if (!drained && admissionValidated && status !== "budget-exhausted" && !persistenceFailed && (!loop?.halt || ["semantic-block", "needs-decision"].includes(loop.halt.code)) &&
      invocation?.association && (invocation.intentions?.length || status === "complete" && !invocation.finishDrain) && !hostHalt) {
    return groupedIO("finishDrain", { operation: "drain" }, invocation).then(() => {
      invocation.finishDrain.receipt = receiptReference(invocation.finishDrain.receipt);
      delete invocation.finishDrain.input;
      return save().then(() => finish(status, reason, true));
    }).catch(error => {
      if (error.code === "superseded") return finish("partial", error.message, true);
      if (error.recovery || error.code === "wrong-cwd") throw error;
      if (canSaveBudgetExhaustion(error))
        return finishBudgetExhaustion().catch(saveError => finish("partial", `${error.message}; ${saveError.message}`, true));
      if (retainUnstartedDispatch(error, error.message))
        return save().then(() => finish(loop.halt.status, loop.halt.reason, true));
      if (error.viewOverflowHalt) {
        loop.halt = error.viewOverflowHalt;
        if (loop.halt.ref) retainHaltProducer(loop.halt.ref, "loop-io");
        return save().then(() => finish(loop.halt.status, loop.halt.reason, true));
      }
      if (error.settlementHalt && !["stopped", "interrupted", "native permission denial"].includes(error.nativeBarrier)) {
        retainSettledNativeHalt(error.settlementHalt);
        return save().then(() => finish(loop.halt.status, loop.halt.reason, true));
      }
      if (error.nativeBarrier && pitakoAgentFamily(error.nativeReference?.agent) === "loop-io" && error.nativeReference.runId)
        loop.halt = loopIOHalt(error.nativeReference, error.nativeBarrier);
      else if (error.nativeBarrier) loop.halt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
        code: "native-barrier", cause: error.nativeBarrier, reason: String(error.message),
        ...(error.nativeReference ? { ref: clone(error.nativeReference) } : {}) };
      const halted = loop?.halt?.status ?? (status === "partial" ? "partial" : "blocked");
      const diagnostic = String(error.message);
      const retainedReason = persistenceFailed && loop?.halt?.reason && !diagnostic.includes(loop.halt.reason)
        ? `${loop.halt.reason} ${diagnostic}` : diagnostic;
      return (error.nativeBarrier ? save() : Promise.resolve())
        .then(() => finish(halted, retainedReason, true),
          saveError => finish(halted, `${retainedReason}; ${saveError.message}`, true));
    });
  }
  if (persistenceFailed && persistenceReason && !reason.includes(persistenceReason)) reason += ` ${persistenceReason}`;
  const exceptions = status === "complete" ? acceptanceResults().excepted
    .filter(gate => gate.status !== "pass" || gate.exit !== 0)
    .map(({ id, status, exit, logRef, humanRef, reason }) => ({ id, status, exit, logRef, humanRef, reason })) : [];
  return {
    status, heading: exceptions.length ? "Execution complete with exceptions" : `Execution ${status}`,
    ...(exceptions.length ? { exceptions } : {}), reason, invocation: config.invocation,
    missionId: config.missionId, missionPath: config.missionPath, boardTopicId: invocation?.boardTopicId ?? null,
    timeouts: timeoutReport(),
    loopsConsumed: invocation?.consumedLoops ?? 0, maxLoops: maxCycles(),
    elapsedMs: Number.isFinite(invocation?.startedAt) ? Date.now() - invocation.startedAt : null, tokens: metrics(),
    phase: loop?.phase ?? "admission", candidate: loop?.closing?.candidate ?? currentCandidate ?? null,
    loopReport: loop ? loopReport(status === "partial" && loop.outcome === "gaps" && !persistenceFailed ? "gaps" : status, reason) : null,
    actionRequired: ["complete", "budget-exhausted"].includes(status) ? "none" : reason,
    action: action(status, reason),
    publication: "not performed by workflow", references, cancelledScope: cancelledScope(),
    originalProblem: originalProblem(),
  };
}
function retainedTimeoutDisposition(cursor, halt) {
  const action = { actor: "foreground", operation: halt.reason, reason: halt.reason,
    references: [halt.ref], started: false };
  return { ...cursorDisposition(cursor, halt.status, halt.reason), action,
    loopReport: { halt, action, pending: [{ reason: halt.reason, references: action.references }] } };
}
function cursorDisposition(cursor, status, reason) {
  return {
    status, heading: `Execution ${status}`, reason, invocation: config.invocation,
    missionId: config.missionId, missionPath: config.missionPath,
    boardTopicId: cursor.boardTopicId, timeouts: { values: cursor.timeouts, since: null },
    loopsConsumed: cursor.budget.consumedLoops, maxLoops: cursor.budget.maxCycles,
    elapsedMs: null, tokens: { status: "unavailable" }, phase: cursor.loop?.phase ?? "admission",
    candidate: null, loopReport: null, actionRequired: status === "complete" ? "none" : reason,
    action: { actor: status === "complete" ? "none" : "active root", operation: status === "complete" ? "close" : "replay",
      reason, references: [], started: false },
    publication: "not performed by workflow", references: [], cancelledScope: [],
    // A disposition without a reconstructed projection cannot attest a gate
    // against the current checkout. Do not inherit last run's advisory verdict.
    ...(config.originalProblem && cursor.action.kind === "terminal" ? { originalProblem: originalProblem() } : {}),
  };
}
function nextWorkerAttempt(task) {
  const previous = loop.attempt.result;
  let pauseSource = confirmedPausePending() ? { checkpoint: clone(loop.attempt.checkpoint),
    confirmation: clone(previous.checkpoint.confirmation) } : loop.attempt.pauseSource && clone(loop.attempt.pauseSource);
  if (loop.attempt.restore && !confirmedPausePending() && loop.attempt.restore.authority?.confirmedPause) {
    const source = pauseSource ?? { checkpoint: clone(frameIntent(invocation.taskFrame.sources.at(-1))),
      confirmation: clone(loop.attempt.restore.authority.confirmedPause) };
    pauseSource = source;
  }
  if (pauseSource && !invocation.taskFrame.restorationKeys.includes(loop.attempt.checkpoint.key)) {
    invocation.taskFrame.restorationKeys.unshift(loop.attempt.checkpoint.key);
    retainFrameIntent(loop.attempt.checkpoint, "sources", true);
  }
  const source = loop.attempt;
  loop.taskReviewCursor = executeCursor().review;
  const repair = invocation.taskFrame.reviewRepair;
  if (repair && !repair.attempt) repair.attempt = previous.attempt + 1;
  const projected = storeProjection?.P.control.lastAttempt;
  const decisionSource = projected?.taskId === task.id && projected.number === source.number &&
    projected.checkpoint?.key === source.checkpoint?.key && !source.restore && !source.halt ? projected : source;
  const peak = decisionSource.gate?.receipt?.contextPeak ?? null;
  const revival = { opinion: previous.revival?.opinion ?? "fresh", reason: previous.revival?.reason ?? "",
    ...decideRevival(decisionSource, { taskId: task.id, loop: loop.number, candidate: currentCandidate,
      halt: loop.halt, revivalContextPeak: invocation.revivalContextPeak }, peak), peak };
  if (repair) Object.assign(revival, { decision: "fresh", code: "task-review-repair" });
  loop.attempt = { taskId: task.id, index: loop.cursor, number: previous.attempt + 1,
    timeoutMs: effectiveTimeouts().workerMs,
    revival, ...(revival.decision === "resume" && !repair ? { resume: source.launch.runId,
      bindingKey: source.bindingKey ?? source.key, resumeAfter: source.gate.receipt.after,
      boardPostIds: source.boardPostIds ?? [] } : {}),
    key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${previous.attempt + 1}`,
    stage: "intention", undispatched: true, continuationRef: previous.ref,
    ...(source.foldedNextBaseline ? { checkpoint: clone(source.foldedNextBaseline.checkpoint),
      intent: clone(source.foldedNextBaseline.intent), foldedBaseline: clone(source.foldedNextBaseline) } : {}),
    ...(pauseSource ? { pauseSource } : {}) };
}
function restoreCloseContinuation(packet) {
  const current = loop.attempt;
  const task = loop.task;
  if (packet.checkpoint.key !== current.key || packet.checkpoint.attempt !== current.number ||
      packet.attempt.number + 1 !== current.number)
    throw new Error("Close continuation attempt integrity mismatch.");
  invocation.tasks[task.id] = clone(packet.taskState);
  invocation.taskFrame = clone(packet.taskFrame);
  invocation.lastConfirmed = clone(packet.lastConfirmed);
  invocation.intentions = [];
  invocation.lastRequestPage = clone(packet.requests);
  loop.results = clone(packet.results);
  loop.recoveries = clone(packet.recoveries);
  loop.metricSeries = clone(packet.gate.receipt.progress);
  loop.attempt = { ...clone(packet.attempt), stage: "launched",
    gate: { stage: "receipt", receipt: { ...clone(packet.gate.receipt), contextPeak: packet.gate.contextPeak } },
    foldedNextBaseline: { checkpoint: clone(packet.checkpoint), intent: clone(packet.intent) } };
  currentCandidate = candidate(packet.gate.receipt.after);
  for (const body of packet.drained) compactSealedAttempts(body);
  const source = loop.attempt;
  admitWorker({ ...clone(source.launch), ok: true, structuredOutput: packet.worker.value },
    source, task, undefined, source.launch.runId, packet.seal);
  if (invocation.sealPending) queueSeal(invocation.sealPending);
  nextWorkerAttempt(task);
  const regenerated = loop.attempt;
  loop.attempt = { ...regenerated, ...current, continuationRef: regenerated.continuationRef,
    revival: regenerated.revival, ...(regenerated.pauseSource ? { pauseSource: regenerated.pauseSource } : {}) };
  if (current.gate?.stage === "receipt") loop.metricSeries = clone(current.gate.receipt.progress);
  if (current.stage === "launched") delete loop.attempt.undispatched;
}
function checkoutTerminalObservation(observed, childKey, association, number, count) {
  let observation;
  const errors = [observed, ...(observed?.results ?? [])].filter(Boolean);
  if (!observed?.ok || !text(observed.runId) || !text(observed.asyncDir) ||
      observed.agent !== "pitako.checkout-observer" || observed.state !== undefined || observed.terminalOutcome ||
      (observed.key !== undefined && observed.key !== childKey) ||
      errors.some(item => item.error || item.outputSaveError || item.metadataSaveError || item.transcriptError ||
        item.outputPartial || item.truncation || item.timedOut || item.processSignal ||
        item.exitCode !== undefined && item.exitCode !== 0) ||
      (!Array.isArray(observed.results) || observed.results.length !== 1 || observed.results[0]?.exitCode !== 0) ||
      !text(observed.externalAdapter?.outputArtifacts?.stdoutPath) ||
      !text(observed.externalAdapter?.outputArtifacts?.stderrPath))
    throw new Error(`Closing observation ${childKey} lacks successfully published terminal evidence (${observed?.error ?? "status/artifacts unavailable or invalid"}). Inspect the exact native run and output references; reconcile capture, publication or native capacity before continuation, never infer completion or redispatch.`);
  if (typeof observed.output !== "string" || utf8Bytes(observed.output) > 61440)
    throw new Error(`Invalid closing stdout for ${childKey}; inspect its native stdout reference, not a preview or truncated tail.`);
  try { observation = JSON.parse(observed.output); }
  catch { throw new Error(`Invalid closing JSON document for ${childKey}; retain stdout/stderr and reconcile the exact native producer without redispatch.`); }
  if (observation?.code)
    throw Object.assign(new Error(observation.reason), { code: observation.code, recovery: observation.recovery });
  if (observation?.error === "ledger-integrity")
    throw Object.assign(new Error(`Closing ledger integrity failure: ${observation.reason}`), { ledgerIntegrity: true });
  if (!observation || observation.version !== 1 || observation.ok !== true ||
      Object.keys(observation).sort().join(",") !== "checkout,commonDir,ledger,ok,root,store,summaries,version" ||
      observation.root !== association.root || observation.commonDir !== association.commonDir ||
      !validLoopAnchor(observation.ledger, count ?? observation.store?.P?.control.ledger?.count ?? null) ||
      !same(observation.ledger, observation.store?.P?.control.ledger) ||
      !validSummaries(observation.summaries, number) || !candidate(observation.checkout) ||
      Object.keys(observation.checkout ?? {}).sort().join(",") !== "fingerprint,head")
    throw new Error(`Invalid closing observation or physical workspace mismatch for ${childKey}; expected ${association.root} / ${association.commonDir}, observed ${observation?.root ?? "unavailable"} / ${observation?.commonDir ?? "unavailable"}. ${observation?.ok === false ? [observation.reason, observation.nextStep].filter(text).join(" ") : "Inspect the exact native stdout/stderr and designated cwd; preserve the snapshot and pending intention."}`);
  // Retain only the validated candidate/workspace projection, not potentially large Git status text.
  observation = { version: 1, ok: true, root: observation.root, commonDir: observation.commonDir,
    checkout: candidate(observation.checkout), ledger: observation.ledger, summaries: observation.summaries,
    store: decodeLoopIOOutput(observation.store) };
  return observation;
}
function validateClosingProjection(published, context) {
  if (published?.storeId !== context.storeId || !published.head ||
      published.head.seq < context.head.seq || !/^[a-f0-9]{64}$/.test(published.head.hash) ||
      !published.P?.preview.closeReferences.some(reference => reference.loop === context.loop.number &&
        reference.seq === published.head.seq && reference.digest === published.head.hash))
    throw new Error("Invalid closing store projection.");
}
function replayClosingCursor(cursor, keyObservedAgent) {
  const checkoutKey = `${key}.l${cursor.loop.number}.checkout`;
  const synthesis = cursor.action.key.endsWith(".director-synthesis");
  let inspection;
  function verifyClosingAnalysisAgent(agent) {
    const { key, runId } = cursor.action;
    const bound = inspection.haltOriginal?.closingAnalysis;
    if (agent !== undefined && (bound?.key !== key || bound.runId !== runId || bound.agent !== agent))
      throw new Error(`Closing producer identity changed for ${key}.`);
  }
  function observeClosingProducer(producer, agent, classify) {
    const target = producer.runId ?? producer.key;
    function barrierFromOriginal(cause, runId, observedAgent) {
      if (["running", "queued", "pending", "native management activity"].includes(cause))
        throw nativeBarrier(cause, producer);
      if (!matchesCursorRequest(cursor))
        throw new Error("Closing barrier admission integrity mismatch.");
      return Promise.resolve(inspection ?? host(config.inspections[0])).then(observation => {
        if (observation.error) throw new Error(`Closing barrier native original integrity failure: ${observation.error}`);
        capture(observation);
        const witness = observation.haltOriginal?.closingBarriers?.find(item =>
          item.ref.key === producer.key && pitakoAgentFamily(item.ref.agent) === pitakoAgentFamily(agent) &&
          (observedAgent === undefined || item.ref.agent === observedAgent) &&
          (!runId || item.ref.runId === runId) && item.cause === cause);
        if (observation.binding !== cursor.admissionBinding || !witness || !text(witness.ref.runId) ||
            !/^[a-f0-9]{64}$/.test(witness.originalDigest))
          throw Object.assign(nativeBarrier(cause, producer), {
            message: `Closing barrier native original integrity failure for ${producer.key}: ${cause}.`,
          });
        throw Object.assign(nativeBarrier(cause, witness.ref), { settlementHalt: witness });
      });
    }
    return observeStatus(target, true).then(observed => {
      if (producer.runId && observed?.runId && observed.runId !== producer.runId ||
          observed?.key && ![producer.key, target, observed.runId].includes(observed.key) ||
          observed?.agent !== undefined && pitakoAgentFamily(observed.agent) !== pitakoAgentFamily(agent))
        throw new Error(`Closing producer identity changed for ${producer.key}.`);
      const cause = classify(observed, observed?.runId ?? target) ?? classify(observed, target);
      return cause ? barrierFromOriginal(cause, producer.runId ?? observed?.runId, observed?.agent) : observed;
    }, error => {
      if (!error.nativeBarrier) throw error;
      return barrierFromOriginal(error.nativeBarrier, producer.runId);
    });
  }
  if (!synthesis && !cursor.action.runId) {
    // The compliance intention and native settlement can straddle a cursor save.
    // Never pass a key-only reference to the closing writer or launch a replacement
    // while the producer is still visible but its settlement cannot be proved.
    const action = cursor.action;
    if (cursor.budget.rejectedKeys.includes(canonicalDigest(action.key))) {
      const producer = cursor.review?.slots.findLast(slot => slot.key.endsWith(".director-synthesis") && slot.runId);
      if (producer) return replayFinalReview({ ...cursor,
        action: { ...action, key: producer.key, runId: producer.runId } });
    }
    return observeClosingProducer(action, "pitako.reviewer", analysisBarrier).then(observed => {
      if (text(observed?.runId)) {
        const producer = { ...action, runId: observed.runId };
        if (!terminalAnalysis(observed, producer))
          throw new Error(`Closing replay awaits exact terminal evidence for ${action.key}.`);
        return replayClosingCursor({ ...cursor, action: producer }, observed.agent);
      }
      throw new Error(`Closing replay lacks exact compliance evidence for ${action.key}.`);
    });
  }
  return host(config.inspections[0]).then(observation => {
    inspection = observation;
    if (inspection.error) throw new Error(inspection.error);
    if (!matchesCursorRequest(cursor)) throw new Error("Closing replay admission integrity mismatch.");
    if (!inspection.storeFailure) capture(inspection);
    verifyClosingAnalysisAgent(keyObservedAgent);
    replayAdmissionObservation = inspection;
    const checkout = inspection.haltOriginal?.closingCheckout;
    const retained = cursor.inFlight.findLast(ref => ref.role === "checkout-observer" &&
      (ref.key === checkoutKey || ref.key.startsWith(`${checkoutKey}.r`)));
    const producer = checkout?.ref ?? retained ?? { key: checkoutKey };
    return observeClosingProducer(producer, "pitako.checkout-observer", (status, target) =>
      barrier(status, target) ?? inspection.haltOriginal?.closingBarriers?.find(item =>
        item.ref.key === producer.key && item.ref.agent === "pitako.checkout-observer" &&
        (!producer.runId || item.ref.runId === producer.runId))?.cause).then(observed => {
      const publisher = checkout?.publisher;
      if (!publisher) {
        const runId = producer.runId ?? observed?.runId;
        if (!runId) return publishCheckout(producer.key);
        if (!checkout?.settled && !terminalAnalysis(observed, { ...producer, runId }))
          throw new Error(`Closing replay awaits exact terminal evidence for ${producer.key}.`);
        return publishCheckout(checkout?.ref ? checkout.nextKey : `${checkoutKey}.r1`);
      }
      const childKey = `${synthesis ? checkoutKey : cursor.action.key}.closing-replay.r1`;
      const publicationProducer = publisher.key !== producer.key
        ? observeClosingProducer(publisher, "pitako.checkout-observer", barrier) : Promise.resolve(observed);
      return publicationProducer.then(result => {
        if (!text(result?.runId)) return publishCheckout(publisher.key);
        return replayLoopIO(childKey, {
          operation: "advance", root: cursor.root, invocation: cursor.invocation,
          key: childKey.replace(/\.r1$/, ""), storeId: cursor.storeId,
          scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead: cursor.head,
          refs: { input: cursor.action.input, closing: {
            key: cursor.action.key, runId: cursor.action.runId, loop: cursor.loop.number } },
        }).then(({ receipt }) => restoreClosingCursor(cursor, receipt, publisher.key, result));
      });
    });
  });
  function publishCheckout(retryKey) {
    // A failed halt save can leave a settled blocked compliance as the last action.
    // Reconcile it before admitting any checkout publication.
    const reconcileCompliance = synthesis || !cursor.action.runId ? Promise.resolve(null)
      : observeClosingProducer(cursor.action, "pitako.reviewer", analysisBarrier).then(status => {
        const { key, runId } = cursor.action;
        const ref = { key, runId };
        verifyClosingAnalysisAgent(status?.agent);
        if (status?.structuredOutput?.status !== "blocked" &&
            !config.recovery?.originals?.some(original =>
              original.key === key && original.runId === runId && original.structuredOutput?.status === "blocked"))
          return null;
        const { metadata } = capture(inspection);
        if (inspection.binding !== cursor.admissionBinding)
          throw new Error("Closing compliance admission binding mismatch.");
        const result = retainedReadOnlyOriginal(status, ref, metadata.retainedAnalyses);
        if (!result?.ok || result.runId !== runId || result.structuredOutput?.status !== "blocked" ||
            !text(result.structuredOutput.reason))
          throw new Error("Closing compliance blocked original integrity mismatch.");
        const halt = { status: "blocked", code: "semantic-block", reason: excerpt(result.structuredOutput.reason) };
        return persistState(stateKey, { ...cursor, halt: { stage: halt.code, digest: canonicalDigest(halt) } })
          .then(() => ({ retainedSemanticHalt: halt, ref }));
      });
    return reconcileCompliance.then(held => {
      if (held) return held;
      const request = { invocation: cursor.invocation, storeId: cursor.storeId,
        input: { seq: cursor.action.input.seq, digest: cursor.action.input.digest },
        compliance: synthesis ? null : { key: cursor.action.key, runId: cursor.action.runId } };
      return retainNativeCall(runs.all([{ key: retryKey, agent: "pitako.checkout-observer",
        task: JSON.stringify(request), cwd: cursor.root, context: "fresh",
        output: false, outputMode: "inline", outputSchema: false, reads: false, progress: false }])).then(([result]) => {
        const cause = barrier(result);
        if (cause) throw nativeBarrier(cause, nativeReference(retryKey, result), result);
        const observation = checkoutTerminalObservation(result, retryKey,
          { root: cursor.root, commonDir: config.preliminary.commonDir }, cursor.loop.number);
        validateClosingProjection(observation.store, cursor);
        return restoreClosingCursor({ ...cursor, budget: { ...cursor.budget,
          rejectedKeys: cursor.budget.rejectedKeys.filter(digest => digest !== canonicalDigest(retryKey)) } },
          observation.store, retryKey, result);
      });
    });
  }
}
function restoreClosingCursor(cursor, receipt, checkoutKey, observed) {
  const P = receipt.P, admission = P?.prompt.admission, packet = P?.prompt.closing;
  if (!packet || !admission || receipt.storeId !== cursor.storeId ||
      canonicalDigest(admission.association) !== cursor.associationDigest ||
      admission.admissionBinding !== cursor.admissionBinding ||
      admission.association.maxCycles !== cursor.budget.maxCycles)
    throw new Error(`Closing replay admission integrity mismatch (packet=${!!packet}, admission=${!!admission}, store=${receipt.storeId === cursor.storeId}).`);
  if (!observed?.ok || !text(observed.runId))
    throw new Error("Closing replay producer integrity mismatch.");
  const ref = nativeReference(checkoutKey, observed);
  const { observation, ...body } = packet.body;
  if (observation?.root !== cursor.root || observation.commonDir !== admission.association.commonDir)
    throw new Error("Invalid closing replay workspace evidence.");
  let reviewSynthesis;
  if (body.review?.verdict === "material-gaps") {
    const synthesis = body.integratedReview?.originals.at(-1);
    if (!synthesis?.key.endsWith(".director-synthesis"))
      throw new Error("Closing replay lacks the bound review synthesis original.");
    reviewSynthesis = { key: synthesis.key, path: synthesis.path, sha256: synthesis.sha256 };
  }
  // The closing ledger entry is already included in P. The reconstructed
  // loop still owns its usage until foldLoop runs.
  const usageTotals = { ...P.preview.usage };
  for (const { tokens } of body.usage) {
    if (tokens === null) usageTotals.unknown--;
    else { usageTotals.known--; usageTotals.tokens -= tokens; }
  }
  const closingObservation = { ...observation, ledger: P.control.ledger, summaries: packet.summaries,
    store: { head: receipt.head, P, storeId: receipt.storeId } };
  storeProjection = { head: receipt.head, P };
  inFlight.clear();
  dispatchedAction = undefined;
  return {
    version: config.stateVersion, association: admission.association, admissionBinding: admission.admissionBinding,
    amendments: admission.amendments, revivalContextPeak: admission.revivalContextPeak,
    taskReviewer: cursor.models.taskReviewer, taskSynthesis: cursor.models.taskSynthesis,
    reviewModels: Object.fromEntries(["r1", "r2", "synthesis"].map(slot =>
      [slot, { key: `pitako.review.${slot}`, model: cursor.models[slot] }])),
    timeouts: { values: clone(cursor.timeouts), since: null }, startedAt: admission.startedAt, consumedLoops: cursor.budget.consumedLoops,
    budgetRejectedKeys: clone(cursor.budget.rejectedKeys), ledger: P.control.ledger,
    root: cursor.root, epoch: cursor.epoch, head: receipt.head, storeId: receipt.storeId,
    tasks: {}, taskFrame: null, intentions: [], sealPending: null,
    ...(P.control.finishDrain ? { finishDrain: { ...P.control.finishDrain, admitted: true, stage: "receipt" } } : {}),
    lastConfirmed: P.control.lastConfirmed, usageTotals,
    loop: { ...body, reviewSynthesis, phase: "closing", archived: true, startedAt: body.startedAt ?? admission.startedAt,
      closing: { candidate: observation.checkout, sameCandidate: same(observation.checkout, body.candidate),
        observation: closingObservation, ref } },
    planRejections: P.preview.planRejections, closeReferences: [],
    loopSummaries: packet.summaries, demandSources: [], demandObservations: [],
    activePlan: null,
    backlogDigest: cursor.backlogDigest, boardTopicId: cursor.boardTopicId,
    currentView: null, excludedScope: Object.fromEntries((body.cancelledScope ?? []).map(task => [task.id, task])),
  };
}
function replayTaskReviewHalt(cursor) {
  return host(config.inspections[0]).then(observation => {
    replayAdmissionObservation = observation;
    const captured = capture(observation);
    const base = cursor.action.key.replace(/\.task-(reviewer|synthesis)$/, "");
    const original = captured.metadata.retainedAnalyses.find(item => item.key === `${base}.seal` ||
      item.key.startsWith(`${base}.seal.r`));
    if (!original?.sealer && cursor.halt.stage === "native-barrier") {
      return replayNativeInterruption(cursor, cursor.action, closingInterruptionHalt, observation)
        .then(({ retainedActivityHalt }) => retainedActivityHalt);
    }
    const sealed = original?.sealer;
    if (!sealed || canonicalDigest(sealed) !== original.digest || sealed.key !== original.key ||
        sealed.runId !== original.runId || sealed.agent !== "pitako.checkpoint-sealer")
      throw new Error("Task review halt sealer original integrity failure.");
    const ref = { ...nativeReference(original.key, sealed), agent: "pitako.checkpoint-sealer" };
    const cause = barrier(sealed, original.key);
    let halt;
    if (cursor.halt.stage === "native-barrier" && cause) {
      halt = { status: ["stopped", "interrupted"].includes(cause) ? "cancelled" : "blocked",
        code: "native-barrier", cause, reason: excerpt(`${["stopped", "interrupted"].includes(cause)
          ? "Execution cancelled: " : ""}${nativeBarrier(cause).message}`), ref };
      if (canonicalDigest(halt) !== cursor.halt.digest && ["stopped", "interrupted", "native permission denial"].includes(cause))
        halt = closingInterruptionHalt({ ...ref, role: "checkpoint-sealer" }, cause);
    } else if (cursor.halt.stage === "checkpoint-integrity" && !cause && sealed.ok) {
      let observed;
      try { observed = typeof sealed.output === "string" && utf8Bytes(sealed.output) <= 61440
        ? JSON.parse(sealed.output) : null; }
      catch { throw new Error("Sealer settlement stdout integrity failure."); }
      if (observed?.outcome === "mismatch" && Array.isArray(observed.paths))
        halt = checkpointIntegrityHalt(observed, ref);
    }
    if (!halt || canonicalDigest(halt) !== cursor.halt.digest)
      throw new Error("Task review halt original digest integrity mismatch.");
    return observeStatus(original.runId, true).then(current => {
      const currentCause = current?.state === "unknown" ? null : barrier(current, original.runId);
      const currentState = current?.state ?? managementAnalysisState(current, { runId: original.runId });
      if (current?.runId && current.runId !== original.runId ||
          current?.agent && current.agent !== "pitako.checkpoint-sealer" ||
          currentCause && currentCause !== cause ||
          cause && !currentCause && ["complete", "completed", "passed"].includes(currentState))
        throw new Error("Task review halt sealer status integrity mismatch.");
      return halt;
    });
  });
}
const gateRenewalBarriers = {
  "gate-renewal-stop": "stopped",
  "gate-renewal-interrupt": "interrupted",
  "gate-renewal-permission": "native permission denial",
};
function gateRenewalHalt(timeout, cause) {
  return { ...loopIOHalt(timeout.ref, cause), timeoutDigest: canonicalDigest(timeout) };
}
function verifyGateRenewalHalt(cursor, timeout) {
  const cause = gateRenewalBarriers[cursor.halt.stage];
  const halt = cause ? gateRenewalHalt(timeout, cause) : timeout;
  if (canonicalDigest(halt) !== cursor.halt.digest)
    throw new Error("Gate timeout original digest integrity mismatch.");
  if (cause) return { retainedReviewHalt: halt };
}
function observeGateRenewal(cursor, halt, resume) {
  return observeStatus(halt.ref.runId, true).then(observed => {
    if (observed?.runId && observed.runId !== halt.ref.runId ||
        observed?.key && ![halt.key, halt.ref.runId].includes(observed.key) ||
        observed?.agent && observed.agent !== halt.ref.agent)
      throw new Error("Gate timeout producer identity mismatch.");
    const cause = analysisBarrier(observed, halt.ref.runId);
    if (cause) throw nativeBarrier(cause, halt.ref);
    if (!terminalAnalysis(observed, halt.ref))
      throw new Error("Gate timeout producer is not terminal.");
  }).then(resume, error => {
    const stage = Object.keys(gateRenewalBarriers).find(key => gateRenewalBarriers[key] === error.nativeBarrier);
    if (!stage) throw error;
    // A status exception is an observation, not a replacement child original.
    // Bind it to the verified timeout so a later status cannot erase the Stop.
    const blocked = gateRenewalHalt(halt, error.nativeBarrier);
    return persistState(stateKey, { ...cursor, halt: { stage, digest: canonicalDigest(blocked) } })
      .then(() => ({ retainedReviewHalt: blocked }));
  });
}
function replayGateTimeout(cursor) {
  const producer = cursor.inFlight.find(ref => ref.role === "loop-io" &&
    ref.key.replace(/\.r\d+$/, "") === cursor.action.opKey);
  const worker = cursor.inFlight.find(ref => ref.role === "worker");
  if (!producer || !worker || !cursor.loop?.attempt || !Number.isSafeInteger(cursor.action.gateTimeoutMs))
    throw new Error("Gate timeout lacks its recorded producer and worker.");
  return host(config.inspections[0]).then(observation => {
    replayAdmissionObservation = observation;
    const captured = capture(observation);
    const original = captured.metadata.retainedAnalyses.find(item =>
      item.key === producer.key && item.runId === producer.runId);
    const settled = original?.gate;
    if (!settled || canonicalDigest(settled) !== original.witnessDigest ||
        !/^[a-f0-9]{64}$/.test(original.digest) || !nativeTimeout(settled) ||
        settled.key !== producer.key || settled.runId !== producer.runId || pitakoAgentFamily(settled.agent) !== "loop-io")
      throw new Error("Gate timeout original producer integrity mismatch.");
    const ref = nativeReference(producer.key, settled);
    const generation = Number(producer.key.match(/\.g(\d+)\.gate(?:\.r\d+)?$/)?.[1] ?? 1);
    const halt = gateTimeoutHalt({ gate: { ref }, gateGeneration: generation },
      "gate-transport", cursor.action.gateTimeoutMs, settled);
    const held = verifyGateRenewalHalt(cursor, halt);
    if (held) return held;
    const floor = config.timeouts && !Object.keys(config.timeouts).length ? 0 :
      config.timeouts?.gateFloorMs ?? cursor.timeouts.gateFloorMs;
    if (floor <= halt.launchedMs || generation >= 3) return { retainedGateHalt: halt };
    return observeGateRenewal(cursor, halt, () => {
      const nextKey = `${worker.key}.g${generation + 1}.gate`;
      const launchedMs = gateOperationTimeout({
        gates: cursor.action.gateTimeouts.map(timeoutMs => ({ timeoutMs: Math.max(timeoutMs, floor) })),
        metric: cursor.action.gateMetricMs !== 0,
      });
      const input = storedWorkerCloseInput({ ...cursor, intent: cursor.loop.attempt.intent,
        gateFloorMs: floor }, worker, cursor.action.input, "gate");
      input.key = nextKey;
      input.refs.timeoutOriginal = { key: producer.key, runId: producer.runId,
        path: original.path, digest: original.digest };
      // The ordinary fresh generation both verifies the originals and returns P.
      // No separate reconstruction child is admitted on this expected relaunch.
      const renew = (retry = 0) => {
        const childKey = retry ? `${nextKey}.r${retry}` : nextKey;
        return observeStatus(childKey, true).then(observed => {
          const cause = analysisBarrier(observed, childKey);
          if (cause) throw nativeBarrier(cause, { key: childKey, runId: observed.runId });
          return retainNativeCall(runs.all([loopIORequest(childKey, input, launchedMs)]));
        }).then(([result]) => {
          const last = result.output?.trim().split("\n").at(-1);
          let receipt;
          try { if (last && utf8Bytes(last) <= 61440) receipt = JSON.parse(last); } catch (_) { /* Native errors need not be JSON. */ }
          if (receipt?.code === "store-busy" && retry < 2 && !analysisBarrier(result, childKey))
            return renew(retry + 1);
          return { result, receipt, childKey };
        });
      };
      const frozen = floor === cursor.timeouts.gateFloorMs ? Promise.resolve() :
        persistState(stateKey, { ...cursor, timeouts: { ...cursor.timeouts, gateFloorMs: floor } })
          .catch(error => { throw new Error(`Essential persistence failed; dispatch halted: ${error.message}`); });
      return frozen.then(() => renew()).then(({ result, receipt, childKey }) => {
        const cause = analysisBarrier(result, childKey);
        if (cause) throw nativeBarrier(cause, nativeReference(childKey, result));
        if (receipt?.error && receipt.code)
          throw Object.assign(new Error(receipt.reason), { code: receipt.code, recovery: receipt.recovery });
        if (nativeTimeout(result)) {
          const ref = nativeReference(childKey, result);
          const halt = gateTimeoutHalt({ gate: { ref }, gateGeneration: generation + 1 },
            "gate-transport", launchedMs, result);
          return { renewedGateHalt: { halt, cursor: { ...cursor,
            action: { ...cursor.action, opKey: nextKey, gateTimeoutMs: launchedMs },
            timeouts: { ...cursor.timeouts, gateFloorMs: floor },
            inFlight: [...cursor.inFlight.filter(ref => ref.key !== producer.key),
              { key: childKey, runId: result.runId, role: "loop-io" }],
            halt: { stage: "timeout", digest: canonicalDigest(halt) },
          } } };
        }
        if (!terminalLoopIOResult(result, childKey, "gate") || !receipt?.P)
          throw new Error(receipt?.reason ?? "Gate renewal has no terminal projection.");
        receipt = decodeLoopIOOutput(receipt);
        return replayCursorAdmission({ ...cursor, halt: null, head: receipt.head,
          action: { kind: "pending", op: "gate", opKey: nextKey,
            input: receipt.P.control.operation.input } }, receipt).then(restored => {
          restored.loop.attempt.gateGeneration = generation + 1;
          (restored.loop.retired ??= []).push(halt.ref);
          inFlight.delete(producer.key);
          return restored;
        });
      });
    });
  });
}
function replayFinalGateTimeout(cursor) {
  const { action } = cursor;
  const producer = cursor.inFlight.find(ref => ref.role === "loop-io" &&
    ref.key.replace(/\.r\d+$/, "") === action.opKey);
  return host(config.inspections[0]).then(observation => {
    const { metadata } = capture(observation);
    const packet = metadata.timeoutProjection;
    const saved = packet?.finalGateTimeout;
    const original = metadata.retainedAnalyses.find(item => item.key === producer?.key && item.runId === producer.runId);
    if (!saved || !producer || saved.finalGate.producer !== producer.key ||
        !same(packet.head, cursor.head) || packet.storeId !== cursor.storeId ||
        !same(action.input, saved.selectionInput) ||
        !original?.gate || canonicalDigest(original.gate) !== original.witnessDigest ||
        pitakoAgentFamily(original.gate.agent) !== "loop-io" || analysisBarrier(original.gate, producer.runId) ||
        nativeTimeout(original.gate))
      throw new Error("Final acceptance timeout original integrity mismatch.");
    const restored = restoreFinalAcceptance(cursor, { ...saved, head: packet.head, P: packet.P,
      storeId: packet.storeId }, { key: producer.key, runId: producer.runId, agent: original.gate.agent }, observation);
    const descriptor = restored.loop.finalAttempt;
    const generation = Number(action.opKey.match(/\.g([23])\.gate$/)?.[1] ?? 1);
    descriptor.gateGeneration = generation;
    descriptor.gate.timeout = true;
    const failed = acceptanceResults(restored.loop).blocking.filter(gate => gate.status !== "pass" || gate.exit !== 0);
    if (!failed.length || !failed.every(gate => gate.status === "timeout") || saved.receipt.mutated || saved.receipt.reused)
      throw new Error("Final acceptance timeout receipt does not prove a renewable timeout.");
    const launchedMs = action.gateTimeoutMs;
    if (!Number.isSafeInteger(launchedMs)) throw new Error("Final acceptance timeout lacks its recorded deadline.");
    const halt = gateTimeoutHalt(descriptor, "final-acceptance", launchedMs, undefined, restored.loop);
    const held = verifyGateRenewalHalt(cursor, halt);
    if (held) return held;
    const floor = config.timeouts && !Object.keys(config.timeouts).length ? 0 :
      config.timeouts?.gateFloorMs ?? cursor.timeouts.gateFloorMs;
    if (floor <= launchedMs ||
        generation >= 3) return { retainedGateHalt: halt };
    return observeGateRenewal(cursor, halt, () => {
      restored.loop.halt = halt;
      return restored;
    });
  });
}
const reviewerRenewalCauses = ["stopped", "interrupted", "native permission denial"];
function reviewerTimeoutAction(action) {
  return action.kind === "launched" && action.role === "reviewer" &&
    /\.(?:task-(?:reviewer|synthesis)|demand-observation)$/.test(action.key);
}
function observeReviewerTimeoutStatus(runId) {
  return observeStatus(runId, true, message => Object.assign(new Error(message), {
    hostHalt: { stage: "host", reason: excerpt(`Reviewer timeout status observation for ${runId}: ${message}`) },
  }));
}
function checkReviewerTimeoutIdentity(observed, ref) {
  if (observed?.runId && observed.runId !== ref.runId ||
      observed?.key && ![ref.key, ref.runId].includes(observed.key) ||
      observed?.agent && ref.agent && observed.agent !== ref.agent)
    throw new Error("Task review timeout producer identity mismatch.");
}
function reviewerRenewalHalt(timeout, cause) {
  return { code: "native-barrier", status: cause === "native permission denial" ? "blocked" : "cancelled",
    cause, reason: nativeBarrier(cause).message, ref: timeout.ref, timeoutDigest: canonicalDigest(timeout) };
}
function holdReviewerRenewal(cursor, timeout, cause) {
  // The status barrier may be transient in the native view; bind it to the
  // verified timeout, not to a second (nonexistent) terminal settlement.
  const halt = reviewerRenewalHalt(timeout, cause);
  const held = { ...cursor, halt: { stage: "reviewer-renewal-barrier", digest: canonicalDigest(halt) } };
  return persistState(stateKey, held).then(() => ({ retainedReviewHalt: halt }));
}
function replayReviewerTimeout(cursor) {
  return host(config.inspections[0]).then(observation => {
    try { return { observation, captured: capture(observation) }; } catch (error) {
      if (cursor.halt.stage !== "timeout" || !(observation.storeFailure || config.preliminaryStoreFailure) ||
          !["store-corrupt", "cursor-ahead", "store-replaced", "store-unavailable", "store-busy"].includes(error.code))
        throw error;
      // A reader's observation is not authority to quarantine the database.
      const opKey = `${cursor.action.key}.store-check`;
      return checkEpochProducers(cursor.action).then(() => replayLoopIO(opKey, {
        operation: "verifyTimeout", key: opKey, root: cursor.root, invocation: cursor.invocation, cursor,
        storeId: cursor.storeId, expectedHead: cursor.head, scope: `exec:${cursor.invocation}.e${cursor.epoch}`,
        capture: !config.timeoutRecovery,
      })).then(({ receipt }) => {
        if (!receipt?.ok) throw new Error("Timeout store verification has no terminal receipt.");
        // Compare transient recovery against the independent inspector digest.
        const refreshed = observation.storeFailure
          ? host(config.inspections.find(grant => grant.key === `${config.inspections[0].key}.r1`))
          : Promise.resolve(observation);
        return refreshed.then(current => {
          refreshedTimeoutAdmission = { recovery: receipt.recovery ?? config.recovery,
            timeoutRecovery: receipt.timeoutRecovery ?? config.timeoutRecovery };
          return { observation: current, captured: capture(current) };
        });
      });
    }
  }).then(({ observation, captured }) => {
    replayAdmissionObservation = observation;
    const packet = captured.metadata.timeoutProjection;
    const original = captured.metadata.retainedAnalyses.find(item =>
      item.key === cursor.action.key && item.runId === cursor.action.runId);
    const settled = original?.settlement;
    if (!packet || packet.storeId !== cursor.storeId || !same(packet.head, cursor.head) ||
        !same(packet.P?.control.operation?.input, cursor.action.input))
      throw new Error(`Task review timeout projection differs from its cursor head/input: packet=${!!packet}, store=${packet?.storeId === cursor.storeId}, head=${same(packet?.head, cursor.head)}, input=${canonicalJSON(packet?.P?.control.operation?.input ?? null)} expected=${canonicalJSON(cursor.action.input)}.`);
    if (!settled || canonicalDigest(settled) !== original.digest || !nativeTimeout(settled) ||
        settled.key !== undefined && settled.key !== cursor.action.key || settled.runId !== cursor.action.runId ||
        pitakoAgentFamily(settled.agent) !== "reviewer")
      throw new Error(`Task review timeout producer integrity mismatch: ${cursor.action.key}; ${original?.error ?? `settled=${!!settled}, timeout=${nativeTimeout(settled)}, key=${settled?.key}, run=${settled?.runId}, agent=${settled?.agent}`}.`);
    const demand = cursor.action.key.endsWith(".demand-observation");
    const generation = Number(cursor.action.key.match(/\.g([23])\.(?:task-|demand-observation$)/)?.[1] ?? 1);
    if (!Number.isSafeInteger(original.launchedMs) || original.launchedMs < 1 || original.launchedMs > 86400000)
      throw new Error("Task review timeout native deadline unavailable.");
    const call = { key: cursor.action.key, timeoutMs: original.launchedMs, stage: "receipt", timeout: true };
    const halt = analysisTimeoutHalt(call, settled, generation);
    call.ref = clone(halt.ref);
    if (cursor.halt.stage === "reviewer-renewal-barrier") {
      const held = reviewerRenewalCauses.map(cause => reviewerRenewalHalt(halt, cause))
        .find(candidate => canonicalDigest(candidate) === cursor.halt.digest);
      if (!held) throw new Error("Reviewer renewal barrier integrity mismatch.");
      return { retainedReviewHalt: held };
    }
    if (canonicalDigest(halt) !== cursor.halt.digest)
      throw new Error(`Task review timeout halt digest integrity mismatch: ${call.key}, ${call.timeoutMs} ms, generation ${generation}.`);
    return observeReviewerTimeoutStatus(settled.runId).then(observed => {
      checkReviewerTimeoutIdentity(observed, call.ref);
      const cause = analysisBarrier(observed, settled.runId);
      if (cause) throw nativeBarrier(cause, call.ref);
      if (!terminalAnalysis(observed, call.ref))
        throw new Error("Task review timeout producer is not terminal.");
    }).then(() => {
      if ((config.timeouts?.reviewerMs ?? cursor.timeouts.reviewerMs) <= halt.launchedMs ||
          generation >= 3) return { retainedAnalysisHalt: halt };
      const input = packet.P.control.operation;
      if (demand) {
        if (!packet.advance || input.operation !== "advance" || input.loop !== cursor.loop.number)
          throw new Error("Demand observation timeout lacks its committed advance.");
        return replayCursorAdmission({ ...cursor, halt: null,
          action: { kind: "pending", op: "advance", opKey: input.key, input: cursor.action.input } },
        { ...packet.advance, head: packet.head, storeId: packet.storeId, P: packet.P }).then(restored => {
          Object.assign(restored.loop, { halt, analysisCalls: [call],
            analysisGenerations: { "demand-observation": generation },
            demandOriginalsVerified: packet.verifiedOriginals });
          restored.lastRequestReceipt = receiptReference(packet.advance);
          dispatchedAction = clone(cursor.action);
          return restored;
        });
      }
      const worker = packet.P.prompt.execution?.worker?.reference;
      if (!worker || packet.context?.key !== worker.key || input.operation !== "gate")
        throw new Error("Task review timeout lacks its committed worker and delta.");
      const receipt = { ...packet.gate, head: packet.head, storeId: packet.storeId, P: packet.P };
      // Reuse the ordinary gate reducer without admitting a reconstruction child.
      return replayCursorAdmission({ ...cursor, halt: null, review: null,
        inFlight: cursor.inFlight.filter(ref => ref.role !== "worker"),
        action: { kind: "pending", op: "gate", opKey: input.key, input: cursor.action.input } }, receipt).then(restored => {
        const attempt = restored.loop.attempt;
        attempt.delta = { key: `${worker.key}.delta`, retry: 0, stage: "receipt", receipt: packet.context.delta };
        attempt.taskReview = {};
        restored.requestObservation = packet.context.requestObservation;
        restored.loop.analysisCalls = [call];
        restored.loop.analysisGenerations = {};
        for (const slot of cursor.review?.slots ?? []) {
          if (slot.phase !== "reviewer") continue;
          const stage = slot.key.endsWith(".task-synthesis") ? "synthesis" : "reviewer";
          restored.loop.analysisGenerations[`${worker.key}.task-${stage}`] =
            Number(slot.key.match(/\.g([23])\.task-/)?.[1] ?? 1);
          if (slot.key === call.key) continue;
          const original = captured.metadata.retainedAnalyses.find(item =>
            item.key === slot.key && item.runId === slot.runId);
          const result = original?.settlement;
          if (!result || canonicalDigest(result) !== original.digest || !result.ok ||
              result.key !== undefined && result.key !== slot.key || result.runId !== slot.runId || pitakoAgentFamily(result.agent) !== "reviewer" ||
              !result.structuredOutput)
            throw new Error("Task review timeout sibling original integrity mismatch.");
          const path = result.results?.find(item => text(item.savedOutputPath))?.savedOutputPath;
          if (!path) throw new Error("Task review timeout sibling original path unavailable.");
          const reference = { key: slot.key, runId: slot.runId, path, digest: canonicalDigest(result.structuredOutput) };
          attempt.taskReview[stage] = reference;
          const task = restored.loop.task;
          const carried = !!task.remaining?.length || (task.progress?.last5?.length ?? 0) > 0 ||
            (task.progress?.nonImproving ?? 0) > 0;
          (restored.taskFrame.reviewProjections ??= {})[slot.key] =
            taskReviewProjection(result.structuredOutput, reference, carried);
          restored.loop.analysisCalls.push({ key: slot.key, stage: "receipt", ref: nativeReference(slot.key, result) });
          analysisResults.set(slot.key, result);
        }
        if (restored.foldedContinuation) {
          restored.foldedContinuation = clone(restored.foldedContinuation);
          restored.foldedContinuation.taskFrame.reviewProjections =
            clone(restored.taskFrame.reviewProjections ?? {});
        }
        restored.loop.analysisCalls.sort((a, b) =>
          cursor.review.slots.findIndex(slot => slot.key === a.key) -
          cursor.review.slots.findIndex(slot => slot.key === b.key));
        restored.loop.halt = halt;
        dispatchedAction = clone(cursor.action);
        return restored;
      });
    }, error => {
      if (!reviewerRenewalCauses.includes(error?.nativeBarrier)) throw error;
      return holdReviewerRenewal(cursor, halt, error.nativeBarrier);
    });
  }).catch(error => {
    // Without the verified timeout original, retain the observation, not a new settlement.
    if (!error.hostHalt && reviewerRenewalCauses.includes(error.nativeBarrier))
      error.hostHalt = { stage: error.nativeBarrier === "native permission denial" ? "host" : "host-stop",
        reason: excerpt(`Reviewer timeout replay for ${error.nativeReference?.key ?? cursor.action.key}: ${error.message}`) };
    throw error;
  });
}
function finalDrainInput(cursor, expectedHead = cursor.head) {
  const { action } = cursor;
  return { operation: "drain", root: cursor.root, invocation: cursor.invocation, key: action.opKey,
    storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead,
    refs: { input: action.input } };
}
function admitFinalDrain(cursor, receipt) {
  const drain = receipt?.replayedDrain;
  if (!drain || drain.key !== cursor.action.opKey || drain.loop !== cursor.loop.number ||
      drain.outcome !== cursor.loop.outcome || !["gaps", "complete"].includes(drain.outcome) ||
      drain.associationDigest !== cursor.associationDigest || drain.admissionBinding !== cursor.admissionBinding ||
      receipt.storeId !== cursor.storeId || receipt.head?.seq < cursor.head.seq)
    throw new Error("Final drain replay differs from its admitted position.");
  return { receipt, drain };
}
function replayFinalDrain(cursor, producer) {
  const { action } = cursor;
  const anchored = finalDrainInput(cursor, { seq: action.input.seq, hash: action.input.digest });
  const recorded = canonicalDigest(anchored) === action.drainDigest;
  const input = recorded ? anchored : finalDrainInput(cursor);
  const retry = Number(producer?.key.match(/\.r(\d+)$/)?.[1] ?? 0) + 1;
  const childKey = recorded ? producer?.key ?? action.opKey : `${action.opKey}.r${retry}`;
  if (!recorded && action.drainDigest)
    input.refs.drain = { digest: action.drainDigest, producer: producer
      ? { key: producer.key, runId: producer.runId } : null };
  return replayLoopIO(childKey, input).then(({ receipt }) => ({ replayedDrain: admitFinalDrain(cursor, receipt) }));
}
function finishFinalDrain(retainedCursor, { receipt, drain }) {
  const cursor = { ...retainedCursor, head: receipt.head, halt: null, action: { kind: "terminal" },
    backlogDigest: drain.backlogDigest ?? retainedCursor.backlogDigest,
    budget: { ...retainedCursor.budget, rejectedKeys: retainedCursor.budget.rejectedKeys.filter(
      digest => digest !== canonicalDigest(drain.key)) },
    inFlight: retainedCursor.inFlight.filter(ref => ref.key.replace(/\.r\d+$/, "") !== drain.key) };
  return persistState(stateKey, cursor).then(() => {
    const status = drain.outcome === "complete" ? "complete" : "partial";
    return { ...cursorDisposition(cursor, status, "Final drain admitted from its committed receipt."),
      loopReport: { work: drain.work, history: { summaries: drain.summaries } } };
  }, error => cursorDisposition(retainedCursor, "partial",
    `Essential persistence failed; final drain already committed: ${String(error?.message ?? error)}`));
}
function replayLoopIO(childKey, input, timeoutMs, maxRetries = 2) {
  function issue(retry) {
    const currentKey = retry ? `${childKey.replace(/\.r\d+$/, "")}.r${Number(childKey.match(/\.r(\d+)$/)?.[1] ?? 0) + retry}` : childKey;
    const request = typeof input === "function" ? input(currentKey) : input;
    return retainNativeCall(runs.all([loopIORequest(currentKey, request, timeoutMs)])).then(([result]) => {
      const cause = barrier(result, currentKey);
      const last = result.output?.trim().split("\n").at(-1);
      let receipt;
      try { if (last && utf8Bytes(last) <= 61440) receipt = JSON.parse(last); } catch (_) { /* Native errors need not be JSON. */ }
      if (cause) throw nativeBarrier(cause, nativeReference(currentKey, result), result);
      if (receipt?.code === "store-busy" && retry < maxRetries) return issue(retry + 1);
      loopIOViewOverflow(receipt, nativeReference(currentKey, result));
      if (receipt?.error) throw Object.assign(new Error(receipt.reason), { code: receipt.code, recovery: receipt.recovery,
        rejectedDrain: receipt.rejectedDrain });
      if (!receipt || !terminalLoopIOResult(result, currentKey, request.operation))
        throw new Error(result.error ?? `Execute replay has no terminal receipt. ${excerpt(result.output ?? "")}`);
      return { receipt: decodeLoopIOOutput(receipt), result, childKey: currentKey };
    });
  }
  return issue(0);
}
function replayInitialAdvance({ storeId, input }, previous) {
  const epoch = previous ? previous.epoch + 1 : 0;
  const number = (previous?.budget.consumedLoops ?? 0) + 1;
  const opKey = `${key}.l${number}.advance`;
  function replayKey(index) {
    const producer = index ? `${opKey}.r${index}` : opKey;
    return observeStatus(producer, true).then(observed => {
      const cause = analysisBarrier(observed, observed?.runId ?? producer) ?? analysisBarrier(observed, producer);
      if (cause) throw nativeBarrier(cause, { key: producer, runId: observed?.runId });
      if (observed?.key && ![producer, observed.runId].includes(observed.key) ||
          observed?.agent && pitakoAgentFamily(observed.agent) !== "loop-io")
        throw new Error("Initial advance replay producer identity mismatch.");
      // A transport retry can have admitted the original params before the cut.
      return index && !observed?.runId && !managementAnalysisState(observed, { key: producer })
        ? producer : replayKey(index + 1);
    });
  }
  return replayKey(previous ? 0 : 1).then(childKey => replayLoopIO(childKey, {
    operation: "advance", root: config.root, invocation: config.invocation, key: opKey,
    storeId, scope: `exec:${config.invocation}.e${epoch}`, expectedHead: { seq: input.seq, hash: input.digest },
    refs: { input: { seq: input.seq, digest: input.digest } },
  })).then(({ receipt }) => {
    const admission = receipt.P?.prompt.admission, operation = receipt.P?.control.operation;
    if (!admission || operation?.operation !== "advance" || operation.key !== opKey ||
        !same(operation.input, input) || !same(admission.amendments ?? [], config.amendments ?? []))
      throw new Error("Initial advance replay admission integrity mismatch.");
    const cursor = {
      root: config.root, invocation: config.invocation, epoch, storeId, head: receipt.head,
      associationDigest: canonicalDigest(admission.association), admissionBinding: admission.admissionBinding,
      action: { kind: "pending", op: "advance", opKey, input },
      inFlight: [],
      loop: { number, phase: "director", cursor: 0, attempt: null },
      budget: { consumedLoops: number, maxCycles: admission.association.maxCycles,
        rejectedKeys: previous?.budget.rejectedKeys ?? [] },
      models: { taskReviewer: admission.models.taskReviewer, taskSynthesis: admission.models.taskSynthesis,
        ...Object.fromEntries(["r1", "r2", "synthesis"].map(slot => [slot, admission.models[slot].model])) },
      timeouts: admission.timeouts?.values ?? effectiveTimeouts(),
    };
    if (!matchesCursorRequest(cursor) || previous && (cursor.associationDigest !== previous.associationDigest ||
        cursor.admissionBinding !== previous.admissionBinding || storeId === previous.storeId))
      throw new Error("Initial advance replay association integrity mismatch.");
    return replayCursorAdmission(cursor, receipt).then(restored => ({ restored, receipt }));
  });
}
function isCurrentDirector(cursor, ref) {
  const directorKey = `${key}.l${cursor.loop?.number}.director`;
  return ref.role === "execution-director" && (ref.key === directorKey || ref.key === `${directorKey}.d1`);
}
function boundInspectorDirector(cursor) {
  return cursor.inFlight.findLast(ref => isCurrentDirector(cursor, ref));
}
function replayDirectorSelection(cursor, inspection, observedDirector) {
  const action = inspection ? boundInspectorDirector(cursor) : cursor.action;
  if (!action) throw new Error("Inspector selection replay lacks its bound director.");
  const ref = { key: action.key, runId: action.runId };
  return (observedDirector ? Promise.resolve(observedDirector) : observeStatus(ref.runId, true)).then(observed => {
    const cause = analysisBarrier(observed, ref.runId);
    if (cause) throw nativeBarrier(cause, ref);
    if (observed?.runId !== ref.runId && !managementAnalysisState(observed, ref) ||
        observed?.key && ![ref.key, ref.runId].includes(observed.key) ||
        observed?.agent && observed.agent !== "pitako.execution-director" || !terminalAnalysis(observed, ref))
      throw new Error("Selection replay awaits its exact settled director.");
    return inspection?.observation ?? host(config.inspections[0]);
  }).then(observation => {
    if (!observation.storeFailure && !config.preliminaryStoreFailure) return observation;
    const failure = observation.storeFailure ?? config.preliminaryStoreFailure;
    if (failure.code === EXECUTE_CONTINUATION_INCOMPATIBLE)
      throw new StoreError(failure.code, failure.reason);
    if (observation.storeFailure?.code === "superseded")
      throw Object.assign(new Error(observation.storeFailure.reason), { code: "superseded" });
    const opKey = `${action.key}.store-check`;
    return checkEpochProducers().then(() => replayLoopIO(opKey, {
      operation: "verifySelection", key: opKey, root: cursor.root, invocation: cursor.invocation,
      storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead: cursor.head,
    })).then(() => observation.storeFailure
      ? host(config.inspections.find(grant => grant.key === `${config.inspections[0].key}.r1`))
      : observation);
  }).then(admitSelection);

  function admitSelection(observation) {
    capture(observation, { ...config, preliminaryStoreFailure: undefined });
    replayAdmissionObservation = observation;
    const { packet, digest } = observation.selectionRecovery ?? {};
    const selectionKey = action.key.replace(/\.director(?=\.d1$|$)/, ".selectionIO");
    if (packet && (canonicalDigest({ packet, cursorHead: clone(cursor.head), director: action.runId }) !== digest ||
        packet.key !== selectionKey || packet.head?.seq <= cursor.head.seq))
      throw new Error("Selection replay differs from its exact committed result.");
    const head = packet?.head ?? cursor.head;
    const advance = cursor.action.input;
    const input = committedIntentReference(packet?.input ?? advance, head);
    const producer = cursor.inFlight.findLast(item => item.role === "loop-io" &&
      item.key.replace(/\.r\d+$/, "") === selectionKey) ?? { key: selectionKey };
    return observeStatus(producer.runId ?? producer.key, true).then(selected => {
      const selectionBarrier = analysisBarrier(selected, producer.runId ?? producer.key);
      if (selectionBarrier) throw nativeBarrier(selectionBarrier, producer);
      if (producer.runId && selected?.runId !== producer.runId && !managementAnalysisState(selected, producer) ||
          selected?.agent && pitakoAgentFamily(selected.agent) !== "loop-io")
        throw new Error("Selection replay producer identity mismatch.");
      return replaySelection(producer);
    });

    function replaySelection(producer) {
      const unimpeded = { ...cursor, inFlight: cursor.inFlight.filter(item =>
        item.key !== producer.key && item.key !== ref.key), halt: null };
      function pendingDrain(drainKey, head, input) {
        if (drainKey.replace(/\.finishDrain(?:\.v[1-9]\d*)?$/, ".selectionIO") !== selectionKey.replace(/\.d1$/, "") ||
            input.seq !== head.seq || input.digest !== head.hash || cursor.budget.consumedLoops !== cursor.budget.maxCycles)
          throw new Error("Selection rejection replay differs from its committed drain.");
        const pending = { ...unimpeded, head, loop: { ...cursor.loop, outcome: "gaps" },
          action: { kind: "pending", op: "drain", opKey: drainKey, input } };
        pending.action.drainDigest = canonicalDigest(finalDrainInput(pending));
        return { pendingSelectionDrain: pending };
      }
      if (packet?.drainKey) return pendingDrain(packet.drainKey, head, input);
      const retry = Number(producer.key.match(/\.r(\d+)$/)?.[1] ?? 0) + 1;
      const retryKey = `${selectionKey}.r${retry}`;
      return observeStatus(retryKey, true).then(retryStatus => {
        const retryBarrier = analysisBarrier(retryStatus, retryKey);
        if (retryBarrier) throw nativeBarrier(retryBarrier, { key: retryKey, runId: retryStatus.runId });
        return replayLoopIO(retryKey, {
          operation: "selection", root: cursor.root, invocation: cursor.invocation, key: selectionKey,
          storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead: cursor.head,
          refs: { input: advance, director: ref, loop: cursor.loop.number,
            consumedLoops: cursor.budget.consumedLoops, backlogDigest: cursor.backlogDigest,
            reviewerMs: cursor.timeouts.reviewerMs,
            ...(inspection ? { inspector: inspection.ref } : {}),
            ...(cursor.budget.consumedLoops === cursor.budget.maxCycles ? { spec: config.preliminary.content } : {}) },
        }).then(({ receipt }) => admitReceipt(receipt), error => {
          const drain = !packet && error.rejectedDrain;
          if (!drain || drain.storeId !== cursor.storeId || drain.head?.seq <= head.seq) throw error;
          return pendingDrain(drain.key, drain.head, committedIntentReference({ seq: drain.head.seq, digest: drain.head.hash }, drain.head));
        });
      });

      function admitReceipt(receipt) {
        if (!packet && receipt.selectionFailure) {
          const { plan, reason, replayRejected, usage, requestObservation, analysisCalls, previous } = receipt.selectionFailure;
          if (receipt.head?.seq > cursor.head.seq || !same(receipt.P?.control.operation?.input, advance) ||
              plan?.ref.key !== ref.key || plan.ref.runId !== ref.runId)
            throw new Error("Selection rejection replay differs from its advance and director.");
          inFlight.delete(producer.key);
          inFlight.delete(ref.key);
          return replayCursorAdmission({ ...unimpeded, action: {
            kind: "pending", op: "advance", opKey: receipt.P.control.operation.key, input: advance,
          } }, receipt).then(restored => {
            restored.head = cursor.head;
            restored.requestObservation = requestObservation;
            Object.assign(restored.loop, { plan, usage, analysisCalls, recoveries: receipt.selectionFailure.recoveries ?? [],
              ...(previous ? { directorRetry: previous } : {}), replayedSelectionFailure: { reason, replayRejected } });
            return restored;
          });
        }
        if (packet && (!same(receipt.head, head) || !same(receipt.P?.control.operation?.input, input)) ||
            !packet && receipt.head?.seq <= head.seq ||
            !same(receipt.P?.prompt.execution?.plan?.ref && {
              key: receipt.P.prompt.execution.plan.ref.key, runId: receipt.P.prompt.execution.plan.ref.runId,
            }, ref))
          throw new Error("Selection replay differs from its committed receipt and director.");
        inFlight.delete(producer.key);
        inFlight.delete(ref.key);
        return replayCursorAdmission(unimpeded, receipt, false, selectionKey);
      }
    }
  }
}
function replayNativeInterruption(cursor, action, rebuild, capturedObservation) {
  if (!matchesCursorRequest(cursor))
    throw new Error("Retained interruption admission integrity mismatch.");
  if (!action.runId) throw new Error("Retained interruption lacks its exact native original.");
  let statusBarrier;
  const family = pitakoAgentFamily(`pitako.${action.role}`);
  return observeStatus(action.runId, true).catch(error => {
    if (!["stopped", "native permission denial"].includes(error.nativeBarrier)) throw error;
    statusBarrier = error.nativeBarrier;
  }).then(observed => {
    if (observed?.runId && observed.runId !== action.runId ||
        observed?.key && ![action.key, action.runId].includes(observed.key) ||
        observed?.agent !== undefined && pitakoAgentFamily(observed.agent) !== family)
      throw new Error("Retained interruption producer integrity mismatch.");
    const current = statusBarrier ?? analysisBarrier(observed, action.runId);
    if (current && !["stopped", "interrupted", "native permission denial"].includes(current))
      throw nativeBarrier(current, action);
    return Promise.resolve(capturedObservation ?? host(config.inspections[0])).then(observation => {
      const { metadata } = capture(observation);
      const settlement = metadata.retainedAnalyses.find(ref => ref.key === action.key && ref.runId === action.runId);
      if (observation.binding !== cursor.admissionBinding ||
          !family || pitakoAgentFamily(settlement?.agent) !== family ||
          !["stopped", "interrupted", "native permission denial"].includes(settlement?.cause) ||
          !text(settlement.path) || !/^[a-f0-9]{64}$/.test(settlement.digest ?? ""))
        throw new Error("Retained interruption native original integrity failure: missing or invalid settlement.");
      if (observed?.agent !== undefined && observed.agent !== settlement.agent)
        throw new Error("Retained interruption producer integrity mismatch.");
      const halt = rebuild(action, settlement.cause);
      if (canonicalDigest(halt) !== cursor.halt.digest || current && current !== halt.cause ||
          !current && ["passed", "complete", "completed"].includes(managementAnalysisState(observed, action) ?? observed?.state))
        throw new Error("Retained interruption halt digest or status integrity mismatch.");
      return { retainedActivityHalt: halt };
    });
  });
}
function replayCommittedHalt(cursor) {
  if (!matchesCursorRequest(cursor)) throw new Error("Retained halt admission integrity mismatch.");
  return host(config.inspections[0]).then(observation => {
    if (text(observation.error)) throw new Error(`Retained halt integrity failure: ${observation.error}`);
    capture(observation);
    const original = observation.haltOriginal;
    const halt = cursor.halt.stage === "spawn-budget" && cursor.budget.lastProgress && cursor.budget.rejectedKeys.length
      ? spawnBudgetHalt(cursor.budget.lastProgress)
      : original?.native ? settledNativeHalt(original.native)
      : original?.checkpoint ? { status: "blocked", code: "checkpoint-integrity", ...original.checkpoint }
      : original?.conflict ? { status: "blocked", code: cursor.halt.stage, ...original.conflict,
          reason: excerpt(original.conflict.reason) }
      : original?.worker ? {
      status: "blocked", code: "semantic-block", reason: excerpt(original.worker.diagnosis), ref: original.worker.ref,
    } : original?.needsDecision ? needsDecisionHalt(original.needsDecision)
      : original?.acceptance && (cursor.halt.stage !== "repeat-acceptance" || original.acceptance.reused)
        ? finalAcceptanceHalt(cursor.halt.stage, original.acceptance.reused, original.acceptance.results) : null;
    if (observation.binding !== cursor.admissionBinding || !halt ||
        halt.code !== (cursor.halt.stage === "native-settlement" ? "native-barrier" : cursor.halt.stage) ||
        canonicalDigest(halt) !== cursor.halt.digest)
      throw new Error("Retained halt native original or digest integrity mismatch.");
    if (original?.worker) return { retainedSemanticHalt: halt, ref: halt.ref };
    return { retainedActivityHalt: halt };
  });
}
function finalGateReplayRequest(cursor, childKey) {
  const { input } = cursor.action;
  // The pending input is stable across the gate COMMIT and cursor save.
  return { operation: "gate", root: cursor.root, invocation: cursor.invocation, key: childKey,
    storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`,
    expectedHead: { seq: input.seq, hash: input.digest },
    refs: { input, committed: true, gateFloorMs: cursor.timeouts.gateFloorMs } };
}
function replayFinalAcceptance(cursor, early) {
  const { opKey } = cursor.action;
  if (!matchesCursorRequest(cursor)) throw new Error("Final acceptance replay admission integrity mismatch.");
  const producer = cursor.inFlight.find(ref => ref.role === "loop-io" &&
    ref.key.replace(/\.r\d+$/, "") === opKey) ?? { key: opKey };
  return observeStatus(producer.runId ?? producer.key, true).then(observed => {
    const cause = analysisBarrier(observed, producer.runId ?? producer.key);
    if (cause) throw nativeBarrier(cause, nativeReference(producer.key, observed));
    if (observed?.agent && pitakoAgentFamily(observed.agent) !== "loop-io" ||
        observed?.key && ![producer.key, producer.runId].includes(observed.key) ||
        producer.runId && observed?.runId && observed.runId !== producer.runId)
      throw new Error("Final acceptance replay producer integrity mismatch.");
    return host(config.inspections[0]);
  }).then(observation => {
    if (text(observation.error)) throw new Error([observation.error, observation.next].filter(Boolean).join(" "));
    // The stable replay input alone cannot detect a lost saved cursor head.
    if (observation.storeFailure?.code === "cursor-ahead") {
      const opKey = `${cursor.action.opKey}.store-check`;
      return checkEpochProducers().then(() => replayLoopIO(opKey, {
        operation: "verifySelection", key: opKey, root: cursor.root, invocation: cursor.invocation,
        storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead: cursor.head,
      })).then(() => { throw new Error("Final acceptance store check did not resolve the missing cursor head."); });
    }
    const admissionObservation = { ...observation, storeFailure: undefined };
    capture(admissionObservation, { ...config, preliminaryStoreFailure: undefined });
    const retryKey = `${opKey}.r1`;
    return replayLoopIO(retryKey, childKey => {
      const request = finalGateReplayRequest(cursor, childKey);
      if (early) request.refs.analyses = early.refs;
      return request;
    }, cursor.action.gateTimeoutMs, early?.generation > 1 ? 0 : undefined).then(({ receipt: saved, result, childKey }) => {
      const restored = restoreFinalAcceptance(cursor, saved, nativeReference(childKey, result), admissionObservation, early?.action);
      inFlight.delete(producer.key);
      if (!early) return restored;
      if (early.action.key.endsWith(".director-synthesis") && !saved.reviewAccess)
        throw new Error("Renewed review synthesis lacks its verified access receipt.");
      // A renewed prepare intention can identify the generation without a settled producer.
      const originals = early.generation > 1 ? early.refs.filter(ref => ref.runId) : early.refs;
      return admitEarlyAnalyses(saved.analyses, originals).then(calls => {
        restored.loop.analysisCalls = calls;
        if (early.generation > 1) restored.loop.analysisGenerations = { "final-review": early.generation };
        restored.loop.replayedReviewAccess = saved.reviewAccess;
        restored.loop.replayedEarlyReview = true;
        return restored;
      });
    });
  });
}
function restoreFinalAcceptance(cursor, saved, gateRef, admissionObservation, action) {
      const { opKey } = cursor.action;
      const { head, P, finalGate, predecessor, selectionHead, selectionInput, receipt, receiptDigest,
        selection, selectionReference, requestObservation } = saved;
      const admission = P?.prompt.admission, execution = P?.prompt.execution;
      const startedAt = committedLoopOpen(cursor.loop.number, P);
      const gateTask = { id: "final-acceptance", gates: selection?.acceptance, metric: null };
      const anchored = same(head, cursor.head) || head?.seq > cursor.head.seq &&
        (same(predecessor, cursor.head) || same(selectionHead, cursor.head));
      if (!admission || !execution?.plan?.ref || startedAt === undefined || !matchesCursorRequest(cursor) ||
          canonicalDigest(admission.association) !== cursor.associationDigest ||
          admission.admissionBinding !== cursor.admissionBinding || saved.storeId !== cursor.storeId ||
          !anchored || finalGate?.seq !== head.seq || finalGate?.digest !== head.hash ||
          !validGateReceipt(receipt, gateTask, "complete") ||
          !validFinalGateRecord(finalGate, receipt, receiptDigest, opKey, cursor.invocation, cursor.epoch) ||
          !same(selectionInput, P.control.operation?.input) || P.control.operation?.operation !== "selection" ||
          selection?.selected !== null || selection.digest !== cursor.backlogDigest ||
          !Number.isSafeInteger(requestObservation) || requestObservation < 1)
        throw new Error("Final acceptance replay record integrity mismatch.");
      storeProjection = { head, P };
      dispatchedAction = clone(action?.kind ? action : cursor.action);
      // Do not mistake a committed result for evidence that the checkout is still current.
      replayAdmissionObservation = same(candidate(receipt.after), candidate(admissionObservation.checkout))
        ? { ...admissionObservation, checkout: receipt.after } : admissionObservation;
      return {
        version: config.stateVersion, association: admission.association, admissionBinding: admission.admissionBinding,
        replayedFinalGate: true,
        amendments: admission.amendments, revivalContextPeak: admission.revivalContextPeak,
        taskReviewer: cursor.models.taskReviewer, taskSynthesis: cursor.models.taskSynthesis,
        reviewModels: Object.fromEntries(["r1", "r2", "synthesis"].map(slot =>
          [slot, { key: `pitako.review.${slot}`, model: cursor.models[slot] }])),
        timeouts: { values: clone(cursor.timeouts), since: null }, startedAt: admission.startedAt,
        consumedLoops: cursor.budget.consumedLoops, ledger: P.control.ledger,
        requestObservation, lastRequestReceipt: receiptReference(selectionReference),
        receiptReference: receiptReference(selectionReference), budgetRejectedKeys: clone(cursor.budget.rejectedKeys),
        lastConfirmed: P.control.lastConfirmed, usageTotals: P.preview.usage, tasks: {}, taskFrame: null,
        loop: { kind: "final", number: cursor.loop.number, phase: "implementation", cursor: 0,
          startedAt, manifest: [], task: null, results: [], attempt: null,
          usage: clone(execution.usage), recoveries: clone(execution.recoveries ?? []),
          plan: { ...execution.plan, stage: "admitted" }, completedTasks: selection.completedTasks,
          acceptance: selection.acceptance, acceptanceHistory: selection.acceptanceHistory,
          metricSeries: receipt.progress,
          finalAttempt: { key: opKey.replace(/(?:\.g[23])?\.gate$/, ""), number: 1, gate: {
            key: opKey, stage: "receipt", retry: 0, ref: gateRef,
            task: gateTask, receipt, record: { seq: finalGate.seq, digest: finalGate.digest }, producer: finalGate.producer,
          } } },
        planRejections: P.preview.planRejections, closeReferences: P.preview.closeReferences,
        loopSummaries: P.prompt.loopSummaries ?? P.preview.loopSummaries,
        demandSources: P.prompt.demand?.sources ?? [], demandObservations: P.prompt.demand?.observations ?? [],
        excludedScope: Object.fromEntries((selection.cancelledScope ?? []).map(task => [task.id, task])),
        root: cursor.root, epoch: cursor.epoch, head, storeId: saved.storeId,
        backlogDigest: selection.digest, backlogPath: selection.path,
        boardTopicId: receipt.view.topicId, currentView: receipt.view,
      };
}
function admitEarlyAnalyses(originals, refs) {
  if (!Array.isArray(originals) || refs.some(ref => !originals.some(({ reference, digest }) =>
    reference.key === ref.key && (!ref.runId || reference.runId === ref.runId) &&
    (!ref.digest || digest === ref.digest))))
    throw new Error("Early analysis replay receipt lacks its exact producers.");
  return Promise.all(originals.map(({ reference, digest, result }) => {
    const { key, runId, path, sha256 } = reference;
    if (!result.ok || !text(runId) || result.runId !== runId || pitakoAgentFamily(result.agent) !== "reviewer" ||
        !/^[a-f0-9]{64}$/.test(sha256) || canonicalDigest(clone(result.structuredOutput)) !== digest ||
        !result.results?.some(item => item.savedOutputPath === path || item.structuredOutputPath === path))
      throw new Error(`Early analysis replay receipt integrity mismatch for ${key}.`);
    return observeStatus(runId, true).then(observed => {
      const cause = analysisBarrier(observed, runId);
      if (cause) throw nativeBarrier(cause, { key, runId });
      if (observed?.runId && observed.runId !== runId || observed?.key && ![key, runId].includes(observed.key) ||
          observed?.agent && observed.agent !== result.agent || !analysisSettled(observed, reference) ||
          observed?.structuredOutput && canonicalDigest(clone(observed.structuredOutput)) !== digest)
        throw new Error(`Early analysis producer integrity mismatch for ${key}.`);
      analysisResults.set(key, result);
      inFlight.delete(key);
      return { key, stage: "receipt", ref: nativeReference(key, result) };
    });
  }));
}

function replayDemandObservation(cursor) {
  const { action } = cursor;
  const match = action.key.match(/\.l([1-9]\d*)(\.g[23])?\.demand-observation$/);
  const base = `${key}.l${cursor.loop.number}`;
  if (!match || action.key !== `${base}${match[2] ?? ""}.demand-observation` ||
      cursor.loop.number < 2 || !matchesCursorRequest(cursor))
    throw new Error("Demand replay admission integrity mismatch.");
  const generation = Number(match[2]?.slice(2) ?? 1);
  const advance = `${base}.advance`;
  const previous = `${key}.l${cursor.loop.number - 1}.nextAdvance`;
  function observeReplayStatus(target, check) {
    return observeStatus(target, true).then(check).catch(error => {
      if (generation > 1 && error.nativeBarrier === "native permission denial")
        error.hostHalt = { stage: "host",
          reason: excerpt(`Renewed demand status observation for ${target}: ${error.message}`) };
      throw error;
    });
  }
  function observeDemand() {
    const target = action.runId ?? action.key;
    return observeReplayStatus(target, observed => {
      const runId = observed?.runId ?? action.runId;
      const cause = analysisBarrier(observed, target) ?? analysisBarrier(observed, runId);
      if (cause) throw nativeBarrier(cause, { key: action.key, runId });
      if (observed?.runId && action.runId && observed.runId !== action.runId ||
          observed?.key && ![action.key, runId].includes(observed.key) ||
          observed?.agent && pitakoAgentFamily(observed.agent) !== "reviewer")
        throw new Error("Demand replay producer identity mismatch.");
      return runId;
    });
  }
  return observeReplayStatus(advance, observed => {
    const cause = analysisBarrier(observed, advance);
    if (cause) throw nativeBarrier(cause, { key: advance, runId: observed.runId });
    return observed;
  }).then(observed => {
    return host(config.inspections[0]).then(observation => {
      if (text(observation.error)) throw new Error([observation.error, observation.next].filter(Boolean).join(" "));
      const failure = observation.storeFailure ?? config.preliminaryStoreFailure;
      const needsWriter = ["cursor-ahead", "store-corrupt", "store-replaced", "store-unavailable", "store-busy"].includes(failure?.code);
      const opKey = observed?.runId || terminalAnalysis(observed, { key: advance }) ? advance : previous;
      if (needsWriter) checkAdmissionBinding(observation);
      else capture(observation);
      // Don't consume the single retry while a renewed producer is still active.
      return (generation > 1 || needsWriter ? observeDemand() : Promise.resolve(action.runId)).then(runId =>
        (needsWriter ? checkEpochProducers() : Promise.resolve()).then(() => ({ opKey, observation, needsWriter, runId })));
    });
  }).then(({ opKey, observation, needsWriter, runId }) => {
    const analyses = [{ key: action.key, runId, digest: null }];
    return replayLoopIO(`${opKey}.r1`, {
      operation: "advance", key: opKey, root: cursor.root, invocation: cursor.invocation,
      storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`,
      expectedHead: cursor.head, refs: { input: action.input, analyses },
    }, undefined, 0).catch(error => {
      // Reuse the physical admission check rather than dispatch its host key again.
      if (error.recovery) error.epochAdmissionObservation = observation;
      throw error;
    }).then(({ receipt }) => {
      const admissionObservation = needsWriter ? { ...observation, storeFailure: undefined } : observation;
      if (needsWriter) capture(admissionObservation, { ...config, preliminaryStoreFailure: undefined });
      replayAdmissionObservation = admissionObservation;
      const renewal = receipt.demandRenewal;
      if (generation > 1 && renewal?.generation !== generation)
        throw new Error("Renewed demand replay lacks its exact generation.");
      if (renewal?.timeout) {
        const ref = renewal.timeout;
        if (ref.key !== action.key || (runId && ref.runId !== runId) || !text(ref.runId) ||
            pitakoAgentFamily(ref.agent) !== "reviewer" || !nativeTimeout(ref))
          throw new Error("Renewed demand timeout producer integrity mismatch.");
        const halt = analysisTimeoutHalt({ key: action.key, timeoutMs: renewal.launchedMs }, ref, generation);
        return persistState(stateKey, { ...cursor, action: { ...action, runId: ref.runId },
          halt: { stage: "timeout", digest: canonicalDigest(halt) } }).then(() => ({ retainedAnalysisHalt: halt }));
      }
      const undispatched = renewal && renewal.launchedMs === undefined && runId === null;
      return admitEarlyAnalyses(receipt.analyses, undispatched ? [] : analyses).then(calls =>
        replayCursorAdmission({ ...cursor,
          action: { kind: "pending", op: "advance", opKey, input: action.input } }, receipt).then(recovered => {
            recovered.loop.analysisCalls = calls;
            recovered.loop.demandOriginalsVerified = true;
            recovered.replayedEarlyDemand = needsWriter;
            if (renewal) {
              recovered.loop.analysisGenerations = { "demand-observation": generation };
              recovered.loop.retired = [renewal.retired];
              recovered.lastRequestReceipt = receiptReference(receipt);
              dispatchedAction = { ...action, runId: calls[0]?.ref.runId ?? null };
              if (calls.length) Object.assign(calls[0], { timeoutMs: renewal.launchedMs, barrier: null });
            }
            return recovered;
          }));
    });
  });
}

function replayFinalReview(cursor) {
  if (!matchesCursorRequest(cursor)) throw new Error("Final review replay admission integrity mismatch.");
  const request = finalReviewRequest(cursor);
  const { key: synthesisKey, runId } = cursor.action;
  return observeStatus(runId, true).then(observed => {
    const cause = analysisBarrier(observed, runId);
    if (cause) throw nativeBarrier(cause, { key: synthesisKey, runId });
    if (observed?.runId && observed.runId !== runId ||
        observed?.agent !== undefined && pitakoAgentFamily(observed.agent) !== "reviewer" ||
        observed?.key && ![synthesisKey, runId].includes(observed.key))
      throw new Error("Final review replay producer integrity mismatch.");
    return observeStatus(request.key, true).then(publication => {
      const cause = analysisBarrier(publication, request.key);
      if (cause) throw nativeBarrier(cause, { key: request.key, runId: publication?.runId });
      return replayLoopIO(`${request.key}.r1`, { ...request, observedSynthesisAgent: observed?.agent });
    }).then(({ receipt }) => ({ receipt, observedAgent: observed?.agent }));
  }).then(({ receipt, observedAgent }) => {
    const { head, P } = receipt, admission = P?.prompt.admission;
    const gate = P?.prompt.closingSeed?.body.finalAttempt.gate;
    if (!admission || !gate || receipt.storeId !== cursor.storeId ||
        ![head, { seq: gate.record.seq, hash: gate.record.digest }].some(pos => same(pos, cursor.head)) ||
        canonicalDigest(admission.association) !== cursor.associationDigest ||
        admission.admissionBinding !== cursor.admissionBinding ||
        !same(P.control.operation?.input, cursor.action.input))
      throw new Error("Final review replay store integrity mismatch.");
    const restored = { ...clone(P.prompt.closingSeed.body), phase: "compliance" };
    admitFinalReview(receipt, request, restored, observedAgent);
    if (restored.review.verdict !== "clear") restored.phase = "review";
    const checkout = candidate(receipt.checkout);
    if (!same(candidate(gate.receipt.after), checkout))
      throw new Error("Final review replay checkout differs from final acceptance.");
    storeProjection = { head, P };
    dispatchedAction = clone(cursor.action);
    return {
      version: config.stateVersion, association: admission.association, admissionBinding: admission.admissionBinding,
      amendments: admission.amendments, revivalContextPeak: admission.revivalContextPeak,
      taskReviewer: cursor.models.taskReviewer, taskSynthesis: cursor.models.taskSynthesis,
      reviewModels: Object.fromEntries(["r1", "r2", "synthesis"].map(slot => [slot, admission.models[slot]])),
      timeouts: { values: clone(cursor.timeouts), since: null }, startedAt: admission.startedAt,
      consumedLoops: cursor.budget.consumedLoops, ledger: P.control.ledger,
      requestObservation: P.control.requestObservation, lastRequestReceipt: receiptReference(receipt.selectionReference),
      receiptReference: receiptReference(receipt.selectionReference), budgetRejectedKeys: clone(cursor.budget.rejectedKeys),
      lastConfirmed: P.control.lastConfirmed, usageTotals: P.preview.usage, tasks: {}, taskFrame: null,
      loop: { ...restored, metricSeries: gate.receipt.progress, analysisCalls: [], replayedFinalReview: true },
      planRejections: P.preview.planRejections, closeReferences: P.preview.closeReferences,
      loopSummaries: P.prompt.loopSummaries ?? P.preview.loopSummaries,
      demandSources: P.prompt.demand?.sources ?? [], demandObservations: P.prompt.demand?.observations ?? [],
      excludedScope: Object.fromEntries((restored.cancelledScope ?? []).map(task => [task.id, task])),
      root: cursor.root, epoch: cursor.epoch, head, storeId: cursor.storeId,
      backlogDigest: cursor.backlogDigest, backlogPath: P.prompt.execution.backlogPath,
      boardTopicId: gate.receipt.view.topicId, currentView: gate.receipt.view, reviewReplayCheckout: checkout,
    };
  });
}
function replayCursorAdmission(cursor, committedAdvance, observedGrouped = false, selectionReplay) {
  const retainedAction = cursor.action;
  if (cursor.halt?.stage === "timeout" && retainedAction.kind === "launched" &&
      retainedAction.role === "worker" && retainedAction.op === "baseline" && retainedAction.runId &&
      !cursor.hostHalt) return host(config.inspections[0]).then(observation => {
    const { metadata } = capture(observation);
    const packet = metadata.timeoutProjection;
    const original = metadata.retainedAnalyses.find(ref => ref.key === retainedAction.key && ref.runId === retainedAction.runId);
    const settled = original?.settlement;
    if (!packet?.baseline || !same(packet.head, cursor.head) || packet.storeId !== cursor.storeId ||
        !same(packet.P?.control.operation?.input, retainedAction.input))
      throw new Error("Worker timeout committed baseline integrity mismatch.");
    if (!settled || canonicalDigest(settled) !== original.digest || !nativeTimeout(settled) ||
        settled.runId !== retainedAction.runId || settled.agent !== "pitako.worker" ||
        settled.results?.some(entry => entry.agent && entry.agent !== "pitako.worker") ||
        !Number.isSafeInteger(original.launchedMs) || original.launchedMs < 1 || original.launchedMs > 86400000)
      throw new Error("Worker timeout original integrity failure; reconcile the retained writer. No replacement dispatched.");
    return replayCursorAdmission({ ...cursor, halt: null,
      action: { kind: "pending", op: "baseline", opKey: `${retainedAction.key}.baseline`, input: retainedAction.input } },
    { ...packet.baseline, head: packet.head, storeId: packet.storeId, P: packet.P }).then(restored => {
      const attempt = restored.loop.attempt;
      const halt = workerTimeoutHalt(attempt, settled, original.launchedMs);
      if (canonicalDigest(halt) !== cursor.halt.digest)
        throw new Error("Worker timeout halt digest integrity mismatch.");
      if ((config.timeouts?.workerMs ?? cursor.timeouts.workerMs) <= halt.launchedMs ||
          (attempt.timeoutGeneration ?? 1) >= 3) return { retainedAnalysisHalt: halt };
      attempt.launch = clone(halt.ref);
      attempt.timeoutMs = halt.launchedMs;
      attempt.stage = "launched";
      delete attempt.undispatched;
      delete attempt.restore.undispatched;
      restored.loop.halt = halt;
      replayAdmissionObservation = observation;
      dispatchedAction = clone(retainedAction);
      return restored;
    });
  });
  if (retainedAction.kind === "pending" && ["native-barrier", "native-permission"].includes(cursor.halt?.stage)) {
    const producer = cursor.inFlight.findLast(ref => ref.role === "loop-io" &&
      ref.key.replace(/\.r\d+$/, "") === retainedAction.opKey);
    if (producer) return replayNativeInterruption(cursor, producer, loopIOHalt);
  }
  if (["needs-decision", "repeat-acceptance", "environment", "spawn-budget", "plan-conflict", "backlog-conflict", "view-overflow", "checkpoint-witness",
      "native-settlement"].includes(cursor.halt?.stage) ||
      cursor.halt?.stage === "checkpoint-integrity" && cursor.inFlight.some(ref =>
        ref.role === "checkpoint-sealer" || ref.role === "loop-io" && /\.close(?:\.r\d+)?$/.test(ref.key)) ||
      cursor.halt?.stage === "semantic-block" && retainedAction.kind === "pending")
    return replayCommittedHalt(cursor);
  if (retainedAction.kind === "pending" && retainedAction.op === "gate" &&
      retainedAction.opKey === `${key}.l${cursor.loop?.number}.acceptance.gate` &&
      !cursor.loop.taskId && !cursor.loop.attempt && !cursor.loop.outcome &&
      ["implementation", "review"].includes(cursor.loop.phase) && !cursor.halt && !cursor.hostHalt)
    return replayFinalAcceptance(cursor);
  if (retainedAction.kind === "launched" && retainedAction.role === "reviewer" && !cursor.halt && !cursor.hostHalt) {
    if (cursor.loop?.phase === "director" && retainedAction.key.endsWith(".demand-observation"))
      return replayDemandObservation(cursor);
    const generation = cursor.review?.generation ?? 1;
    const renewedSynthesis = generation > 1 && !retainedAction.runId &&
      retainedAction.key.endsWith(".review.director-synthesis");
    if (["implementation", "review"].includes(cursor.loop?.phase) && !cursor.loop.taskId &&
        (renewedSynthesis || /\.review\.(?:director-prepare|independent-[A-Za-z0-9_.-]+-r[12])$/.test(retainedAction.key))) {
      const analyses = (cursor.review?.slots ?? []).filter(slot => slot.runId).map(({ key, runId, digest }) => ({ key, runId, digest }));
      if (retainedAction.runId && !analyses.some(ref => ref.key === retainedAction.key))
        analyses.push({ key: retainedAction.key, runId: retainedAction.runId, digest: null });
      if (generation > 1) {
        const prefix = reviewPrefix(generation, cursor.loop.number);
        if (!retainedAction.key.startsWith(prefix) || analyses.some(ref => !ref.key.startsWith(prefix)))
          throw new Error("Renewed review replay generation integrity mismatch.");
        if (!analyses.length) analyses.push({ key: retainedAction.key, runId: null, digest: null });
      }
      // A denied admission may leave a null runId. The writer resolves settled
      // siblings from the mission; a missing slot is observed before dispatch.
      const opKey = `${key}.l${cursor.loop.number}.acceptance.gate`;
      const action = { kind: "pending", op: "gate", opKey, input: retainedAction.input };
      return replayFinalAcceptance({ ...cursor, action }, { action: retainedAction, refs: analyses, generation });
    }
  }
  if (retainedAction.kind === "launched" && retainedAction.runId === null && cursor.halt &&
      "reason" in cursor.halt) {
    if (!matchesCursorRequest(cursor)) throw new Error("Immutable mission/invocation/snapshot/worktree association changed.");
    if (config.preliminaryStoreFailure) throw new Error(`Retained pre-dispatch halt store integrity failure: ${config.preliminaryStoreFailure.reason}`);
    const halt = noRunHalt(retainedAction, cursor.halt);
    if (canonicalDigest(halt) !== cursor.halt.digest)
      throw new Error("Retained pre-dispatch halt digest integrity mismatch.");
    if (cursor.halt.stage === "native-dispatch" && retainedAction.role === "worker" &&
        cursor.loop?.phase === "implementation" && cursor.loop.attempt?.stage === "launched" &&
        !cursor.hostHalt) {
      // A thrown dispatch can lose delivery of a runId without preventing the launch.
      const { key } = retainedAction;
      return observeStatus(key, true).then(observed => {
        const runId = observed?.runId;
        if (!text(runId) || !observed.ok || analysisBarrier(observed, runId) || nativeTimeout(observed) ||
            !(observed.structuredOutput || analysisSettled(observed, { key, runId })))
          return { retainedDispatchHalt: halt };
        if (observed.key && ![key, runId].includes(observed.key) ||
            observed.agent && observed.agent !== "pitako.worker")
          throw new Error("Execute worker replay producer mismatch.");
        inFlight.set(key, { key, runId, role: "worker" });
        return replayCursorAdmission({ ...cursor, halt: null, action: { ...retainedAction, runId } });
      });
    }
    return Promise.resolve({ retainedDispatchHalt: halt });
  }
  if (cursor.halt?.stage === "task-review-model" && retainedAction.kind === "launched" &&
      retainedAction.role === "reviewer" && retainedAction.runId && /\.task-(reviewer|synthesis)$/.test(retainedAction.key)) {
    if (!matchesCursorRequest(cursor)) throw new Error("Retained task review admission integrity mismatch.");
    const { key, runId } = retainedAction;
    return host(config.inspections[0]).then(observation => {
      const original = capture(observation).metadata.retainedAnalyses.find(ref => ref.key === key && ref.runId === runId);
      const settled = original?.settlement;
      if (!settled || settled.runId !== runId || pitakoAgentFamily(settled.agent) !== "reviewer" ||
          settled.key !== undefined && settled.key !== key || canonicalDigest(settled) !== original.digest ||
          settled.ok && settled.structuredOutput || analysisBarrier(settled, key))
        throw new Error("Retained task review model failure original integrity mismatch.");
      const halt = taskReviewModelHalt(key, settled, cursor.models);
      if (canonicalDigest(halt) !== cursor.halt.digest)
        throw new Error("Retained task review model failure halt integrity mismatch.");
      return { retainedReviewHalt: halt };
    });
  }
  if (retainedAction.kind === "launched" && retainedAction.runId && !cursor.hostHalt &&
      (cursor.halt?.stage === "native-barrier" ||
        cursor.halt?.stage === "native-permission" && ["worker", "reviewer"].includes(retainedAction.role))) {
    const rebuild = retainedAction.role === "worker" ? workerInterruptionHalt :
      retainedAction.role === "execution-director" ? directorInterruptionHalt : null;
    if (rebuild) return replayNativeInterruption(cursor, retainedAction, rebuild);
    if (retainedAction.role === "reviewer" && !/\.task-(reviewer|synthesis)$/.test(retainedAction.key))
      return replayNativeInterruption(cursor, retainedAction, closingInterruptionHalt);
  }
  if (!selectionReplay && retainedAction.kind === "launched" && retainedAction.role === "execution-inspector" &&
      retainedAction.runId && cursor.loop?.phase === "director" &&
      (!cursor.halt || cursor.halt.stage === "recovery") &&
      !cursor.hostHalt) {
    const { key, runId } = retainedAction;
    const ref = { key, runId, agent: "pitako.execution-inspector" };
    return observeStatus(runId, true).then(observed => {
      if (observed?.runId && observed.runId !== runId || observed?.key && ![key, runId].includes(observed.key) ||
          observed?.agent && observed.agent !== ref.agent)
        throw new Error("Recovery producer/run identity conflict.");
      const cause = analysisBarrier(observed, runId);
      if (cause) throw nativeBarrier(cause, ref);
      return host(config.inspections[0]).then(observation => {
        const { metadata } = capture(observation);
        if (observation.binding !== cursor.admissionBinding)
          throw new Error("Recovery admission binding mismatch.");
        const original = retainedReadOnlyOriginal(observed, ref, metadata.retainedAnalyses);
        const value = original?.structuredOutput;
        if (!original?.ok || original.runId !== runId || !value)
          throw new Error("Exact retained recovery original is unavailable.");
        if (!cursor.halt) {
          if (!analysisSettled(observed, ref) || value.status !== "recovered" || value.originalAvailable !== true ||
              !value.original || value.binding === "changed" || value.comparison === "different-full-json" ||
              !text(value.reason) || !Array.isArray(value.provenance) || !value.provenance.length ||
              !value.provenance.every(text))
            throw new Error("Retained recovery original is not an exact settled recovery.");
          return replayDirectorSelection(cursor, { observation, ref: { key, runId, digest: canonicalDigest(clone(value)) } });
        }
        const reason = `Plan recovery unresolved: ${value.reason}`;
        const halt = { status: "blocked", code: "recovery", reason: excerpt(reason) };
        if (value.status !== "unresolved" || !text(value.reason) ||
            !Array.isArray(value.provenance) || !value.provenance.length || !value.provenance.every(text) ||
            canonicalDigest(halt) !== cursor.halt.digest)
          throw new Error("Retained plan recovery original or halt digest is unavailable or changed.");
        return { retainedPlanImpediment: { reason, halt, ref } };
      });
    });
  }
  if (!selectionReplay && retainedAction.kind === "launched" && retainedAction.role === "execution-inspector" &&
      !retainedAction.runId && cursor.loop?.phase === "director" && !cursor.halt && !cursor.hostHalt &&
      cursor.budget.rejectedKeys.includes(canonicalDigest(retainedAction.key))) {
    const director = boundInspectorDirector(cursor);
    if (!director) throw new Error("Rejected inspector lacks its bound director.");
    const sequence = Number(retainedAction.key.match(/\.recover([1-9]\d*)$/)?.[1]);
    if (!Number.isSafeInteger(sequence) || retainedAction.key !== `${key}.l${cursor.loop.number}.recover${sequence}`)
      throw new Error("Rejected inspector recovery key integrity mismatch.");
    return observeReplayDirector(director).then(observed => {
      if (!analysisSettled(observed, director) || observed.runId && observed.runId !== director.runId ||
          observed.key && ![director.key, director.runId].includes(observed.key) ||
          observed.agent && observed.agent !== "pitako.execution-director")
        throw new Error("Rejected inspector awaits its exact settled director.");
      // Use the launch's committed advance ref, including a previous loop's nextAdvance.
      return replayCursorAdmission({ ...cursor, action: { ...director, kind: "launched",
        runId: null, input: retainedAction.input } }, undefined, {
        ...(director.key.endsWith(".d1") ? { retryDirector: { key: director.key, runId: director.runId } } : {}),
      }).then(restored => {
        if (sequence <= restored.recoverySeq)
          throw new Error("Rejected inspector recovery sequence conflicts with its prior selection.");
        restored.recoverySeq = sequence - 1;
        restored.loop.plan ??= { ...projection(director.key, { ...observed, runId: director.runId,
          agent: "pitako.execution-director" }), stage: "published" };
        return restored;
      });
    });
  }
  if (retainedAction.kind === "launched" && retainedAction.role === "reviewer" && retainedAction.runId &&
      (retainedAction.key.includes(".review.") || retainedAction.key.endsWith(".compliance")) &&
      cursor.halt?.stage === "timeout" && !cursor.hostHalt) {
    const { key, runId } = retainedAction;
    return host(config.inspections[0]).then(observation => {
      const { metadata } = capture(observation);
      const original = metadata.retainedAnalyses.find(item => item.key === key && item.runId === runId);
      const settled = original?.settlement;
      if (observation.binding !== cursor.admissionBinding || !settled || canonicalDigest(settled) !== original.digest ||
          settled.key !== undefined && settled.key !== key || settled.runId !== runId ||
          pitakoAgentFamily(settled.agent) !== "reviewer" || !nativeTimeout(settled) ||
          !Number.isSafeInteger(original.launchedMs) || original.launchedMs < 1 || original.launchedMs > 86400000)
        throw new Error("Final review timeout original integrity mismatch.");
      const generation = Number(key.match(/\.g([23])\.(?:review\.|compliance$)/)?.[1] ?? 1);
      const halt = analysisTimeoutHalt({ key, timeoutMs: original.launchedMs }, settled, generation);
      if (canonicalDigest(halt) !== cursor.halt.digest)
        throw new Error("Final review timeout halt digest integrity mismatch.");
      if ((config.timeouts?.reviewerMs ?? cursor.timeouts.reviewerMs) <= halt.launchedMs ||
          generation >= 3) return { retainedAnalysisHalt: halt };
      const packet = metadata.timeoutProjection;
      const saved = packet?.finalGateTimeout;
      if (!saved || packet.storeId !== cursor.storeId || !same(packet.head, cursor.head) ||
          !same(saved.selectionInput, retainedAction.input))
        throw new Error("Final review timeout lacks its committed acceptance projection.");
      const opKey = saved.finalGate.producer.replace(/\.r\d+$/, "");
      const restored = restoreFinalAcceptance({ ...cursor,
        head: { seq: saved.finalGate.seq, hash: saved.finalGate.digest },
        action: { kind: "pending", op: "gate", opKey, input: saved.selectionInput } },
      { ...saved, P: packet.P, storeId: packet.storeId, head: { seq: saved.finalGate.seq, hash: saved.finalGate.digest } },
      { key: saved.finalGate.producer }, observation, retainedAction);
      const call = { key, stage: "receipt", timeout: true, timeoutMs: original.launchedMs, ref: halt.ref };
      const target = restored.loop;
      if (halt.class === "compliance") {
        const seed = packet.archiveSeed;
        if (!seed || seed.body.review.verdict !== "clear" || !same(candidate(seed.body.candidate), candidate(observation.checkout)))
          throw new Error("Compliance timeout differs from its committed review candidate.");
        restored.head = packet.head;
        storeProjection = { head: packet.head, P: packet.P };
        Object.assign(target, seed.body, { phase: "compliance", replayedFinalReview: true });
        admitFinalReview({ storeId: packet.storeId, P: { prompt: { closingSeed: clone(seed) } } },
          { storeId: cursor.storeId, invocation: cursor.invocation,
            refs: { input: seed.input, originals: seed.body.integratedReview.originals } }, target);
        target.analysisCalls.push(call);
      } else {
        target.phase = "review";
        target.candidate = candidate(saved.receipt.after);
        target.analysisCalls = (cursor.review?.slots ?? []).filter(slot => slot.key !== key).map(slot => {
          const original = metadata.retainedAnalyses.find(ref => ref.key === slot.key &&
            (!slot.runId || slot.runId === ref.runId));
          const valid = original?.ok && text(original.runId) && text(original.path) &&
            pitakoAgentFamily(original.agent) === "reviewer" &&
            (!slot.digest || canonicalDigest(original.structuredOutput) === slot.digest);
          return { key: slot.key, stage: valid ? "receipt" : "intention",
            ref: valid ? { key: slot.key, runId: original.runId, agent: original.agent } : { key: slot.key } };
        });
        target.analysisCalls.push(call);
        // Preserve the saved sibling ownership until retirement succeeds.
        target.integratedReview = cursor.review && { phase: cursor.review.phase, originals: clone(cursor.review.slots) };
      }
      target.analysisGenerations = { ...target.analysisGenerations, [halt.class]: generation };
      target.halt = halt;
      return restored;
    });
  }
  if (retainedAction.kind === "launched" && retainedAction.role === "reviewer" && retainedAction.runId &&
      /(?:\.review\.director-(?:prepare|synthesis)|\.compliance)$/.test(retainedAction.key) &&
      cursor.halt?.stage === "semantic-block" && !cursor.hostHalt) {
    const { key, runId } = retainedAction;
    const ref = { key, runId };
    const prepare = key.endsWith(".director-prepare");
    const synthesis = key.endsWith(".director-synthesis");
    return observeStatus(runId, true).then(observed => {
      const cause = analysisBarrier(observed, runId);
      if (cause) throw nativeBarrier(cause, ref);
      if (nativeTimeout(observed) || observed?.runId && observed.runId !== runId ||
          observed?.key && ![key, runId].includes(observed.key) ||
          observed?.agent && pitakoAgentFamily(observed.agent) !== "reviewer")
        throw new Error("Retained review original producer integrity mismatch.");
      return host(config.inspections[0]).then(observation => {
        const { metadata } = capture(observation);
        if (observation.binding !== cursor.admissionBinding)
          throw new Error("Retained review admission binding mismatch.");
        const result = retainedReadOnlyOriginal(observed, ref, metadata.retainedAnalyses);
        const value = result?.structuredOutput;
        const slot = cursor.review?.slots.find(slot => slot.key === key && slot.runId === runId);
        if ((prepare || synthesis) && slot?.digest && value && canonicalDigest(clone(value)) !== slot.digest)
          throw new Error("Retained review original integrity mismatch.");
        if (!result?.ok || result.runId !== runId || !value)
          throw new Error(`Complete retained analysis unavailable for ${runId}; no replacement dispatched.`);
        if ((prepare || synthesis) && !slot?.digest)
          throw new Error(`No admitted original digest for ${key}; no replacement dispatched.`);
        const reason = synthesis && value.status === "ready" && value.screening?.verdict === "blocked"
          ? value.screening.reason : value.status === "blocked" ? value.reason : null;
        const halt = { status: "blocked", code: "semantic-block",
          reason: excerpt(reason && value.status === "blocked" && (prepare || synthesis)
            ? `${prepare ? "director-prepare" : "director-synthesis"}: ${reason}` : reason) };
        if (!text(reason) || canonicalDigest(halt) !== cursor.halt.digest)
          throw new Error("Retained review original integrity mismatch.");
        const disposition = { retainedSemanticHalt: halt, ref };
        if (!synthesis) return disposition;
        const prefix = key.slice(0, -"director-synthesis".length);
        const slots = cursor.review.slots.filter(slot => slot.key.startsWith(`${prefix}independent-`));
        if (!slots.length) throw new Error("Retained synthesis lacks its independent originals.");
        return Promise.all(slots.map(slot => {
          if (!slot.runId || !slot.digest) throw new Error("Retained synthesis original identity unavailable.");
          return observeStatus(slot.runId, true).then(observed => {
            const cause = analysisBarrier(observed, slot.runId);
            if (cause) throw nativeBarrier(cause, slot);
            if (observed?.runId && observed.runId !== slot.runId ||
                observed?.key && ![slot.key, slot.runId].includes(observed.key) ||
                observed?.agent && pitakoAgentFamily(observed.agent) !== "reviewer" || nativeTimeout(observed))
              throw new Error("Retained synthesis original producer integrity mismatch.");
            const original = metadata.retainedAnalyses.find(item => item.key === slot.key && item.runId === slot.runId);
            const result = retainedReadOnlyOriginal(observed, slot, metadata.retainedAnalyses);
            if (!result?.ok || result.runId !== slot.runId || !text(original?.path) ||
                !result.structuredOutput || canonicalDigest(clone(result.structuredOutput)) !== slot.digest)
              throw new Error("Retained synthesis original integrity mismatch.");
            return { id: `${slot.key}.v1.a1`, key: slot.key, path: original.path, digest: slot.digest };
          });
        })).then(() => disposition);
      });
    });
  }
  if (retainedAction.kind === "launched" && retainedAction.runId && cursor.halt?.stage === "capacity" &&
      !cursor.hostHalt) {
    const { key, runId, role } = retainedAction;
    return observeStatus(runId, true).then(observed => {
      const cause = barrier(observed, runId);
      if (cause) throw nativeBarrier(cause, { key, runId });
      if (observed?.ok !== false || observed.runId !== runId ||
          observed.key && ![key, runId].includes(observed.key) ||
          observed.agent && pitakoAgentFamily(observed.agent) !== pitakoAgentFamily(`pitako.${role}`))
        throw new Error("Retained capacity producer identity or refusal is unavailable.");
      const halt = { status: "partial", ...nativeFailure(key, observed.error, observed) };
      if (halt.code !== "capacity" || canonicalDigest(halt) !== cursor.halt.digest)
        throw new Error("Retained capacity receipt integrity mismatch.");
      return { retainedDispatchHalt: halt };
    });
  }
  if (retainedAction.kind === "launched" && retainedAction.role === "worker" && retainedAction.runId &&
      cursor.halt?.stage === "worker-activity" && !cursor.hostHalt) {
    const { key, runId } = retainedAction;
    function retainActivityBarrier(error) {
      const cause = error.nativeBarrier;
      if (!["stopped", "interrupted", "native permission denial"].includes(cause)) throw error;
      const halt = workerInterruptionHalt(retainedAction, cause);
      const held = { ...cursor, halt: {
        stage: "native-barrier", digest: canonicalDigest(halt),
      } };
      return persistState(stateKey, held).then(() => ({ retainedActivityHalt: halt }));
    }
    return observeStatus(runId, true).then(observed => {
      if (observed?.runId && observed.runId !== runId ||
          observed?.key && ![key, runId].includes(observed.key) ||
          observed?.agent && observed.agent !== "pitako.worker")
        throw new Error("Retained active worker producer identity is unavailable.");
      const cause = barrier(observed, runId);
      if (cause) return retainActivityBarrier(nativeBarrier(cause, { key, runId }));
      if (observed?.runId !== runId && !managementAnalysisState(observed, { key, runId }))
        throw new Error("Retained active worker producer identity is unavailable.");
      if (!analysisSettled(observed, { key, runId }) && !(observed?.ok && observed.structuredOutput))
        throw new Error("Retained active worker awaits exact terminal success.");
      return replayCursorAdmission({ ...cursor, halt: null });
    }, retainActivityBarrier);
  }
  if (!selectionReplay && cursor.action.kind === "launched" && cursor.action.role === "execution-director" &&
      cursor.action.runId && cursor.loop?.phase === "director" && !cursor.hostHalt &&
      (!cursor.halt || cursor.halt.stage === "recovery"))
    return replayDirectorSelection(cursor);
  if (!selectionReplay && !observedGrouped && retainedAction.kind === "launched" &&
      isCurrentDirector(cursor, retainedAction) && !retainedAction.runId &&
      cursor.loop?.phase === "director" && !cursor.halt && !cursor.hostHalt) {
    return observeReplayDirector(retainedAction).then(observed => {
      if (text(observed?.runId)) {
        // The native child can settle before the cursor binds its runId.
        // Select from that exact original rather than dispatching the director again.
        return replayDirectorSelection({ ...cursor, action: { ...retainedAction, runId: observed.runId } }, null, observed);
      }
      if (retainedAction.key.endsWith(".d1"))
        return replayCursorAdmission(cursor, undefined, { retryDirector: { key: retainedAction.key, runId: null } });
      return replayCursorAdmission(cursor, committedAdvance, true);
    });
  }
  const selectionCancellation = retainedAction.kind === "pending" && retainedAction.op === "drain" &&
    retainedAction.opKey.startsWith(`${key}.l${cursor.loop?.number}.cancellationDrain`) &&
    cursor.loop?.phase === "implementation" && !cursor.loop.attempt && cursor.loop.cursor === 0;
  if (!selectionReplay && retainedAction.kind === "pending" && (retainedAction.op === "selection" || selectionCancellation) &&
      (cursor.loop?.phase === "director" ||
        cursor.loop?.phase === "implementation" && cursor.loop.cursor === 0) &&
      !cursor.loop.attempt && !cursor.halt && !cursor.hostHalt) {
    const { input } = retainedAction;
    const opKey = selectionCancellation ? `${key}.l${cursor.loop.number}.selectionIO` : retainedAction.opKey;
    const nativeKey = retainedAction.opKey;
    const producer = cursor.inFlight.findLast(ref => ref.role === "loop-io" &&
      ref.key.replace(/\.r\d+$/, "") === nativeKey) ?? { key: nativeKey };
    // This cursor already anchors the committed result, not the director's
    // selection input. Do not reuse the native key of that other replay.
    return observeStatus(producer.runId ?? nativeKey, true).then(observed => {
      const cause = analysisBarrier(observed, producer.runId ?? opKey);
      if (cause) throw nativeBarrier(cause, producer);
      if (producer.runId && observed?.runId !== producer.runId && !managementAnalysisState(observed, producer) ||
          observed?.agent && pitakoAgentFamily(observed.agent) !== "loop-io")
        throw new Error("Committed selection producer identity mismatch.");
      return replayLoopIO(`${opKey}.committed.r1`, { operation: "selection", key: opKey,
        root: cursor.root, invocation: cursor.invocation, storeId: cursor.storeId,
        scope: `exec:${cursor.invocation}.e${cursor.epoch}`, expectedHead: cursor.head,
        refs: { input, committed: true, ...(selectionCancellation ? { cancellationDrain: nativeKey } : {}) },
      });
    }).then(({ receipt }) => {
      const committedKey = receipt.P?.control.operation?.key;
      if (committedKey !== opKey && !(selectionCancellation && committedKey === `${opKey}.d1`))
        throw new Error("Selection replay differs from its committed operation.");
      return replayCursorAdmission({ ...cursor,
        action: { kind: "pending", op: "selection", opKey: committedKey, input }, loop: { ...cursor.loop, phase: "director" } },
        receipt, false, committedKey);
    });
  }
  if (!observedGrouped && cursor.action.kind === "pending" && ["close", "drain"].includes(cursor.action.op) &&
      (!cursor.halt || cursor.halt.stage === "recovery") && !cursor.hostHalt) {
    const producer = cursor.inFlight.findLast(ref => ref.role === "loop-io" &&
      ref.key.replace(/\.r\d+$/, "") === cursor.action.opKey);
    const ref = producer ?? { key: cursor.action.opKey };
    return observeStatus(ref.runId ?? ref.key, true).then(observed => {
      const cause = barrier(observed, ref.runId ?? ref.key);
      if (cause) throw nativeBarrier(cause, ref);
      const management = managementAnalysisState(observed, ref);
      if (producer && (observed?.runId !== producer.runId && !management ||
          observed.agent && pitakoAgentFamily(observed.agent) !== "loop-io"))
        throw new Error("Grouped replay producer identity mismatch.");
      if (producer && !terminalAnalysis(observed, ref) && management !== "passed")
        throw new Error("Grouped replay awaits exact terminal producer evidence.");
      if (cursor.action.op === "drain" &&
          cursor.action.opKey.startsWith(`${key}.l${cursor.loop.number}.cancellationDrain`) &&
          cursor.loop.outcome === "gaps" && cursor.budget.consumedLoops < cursor.budget.maxCycles) {
        const opKey = `${key}.l${cursor.loop.number}.nextAdvance`;
        return replayLoopIO(`${opKey}.r1`, { ...finalDrainInput(cursor), operation: "advance",
          key: opKey, refs: { input: cursor.action.input, cancellationDrain: cursor.action.opKey } })
          .then(({ receipt }) => replayCursorAdmission({ ...cursor, halt: null,
            action: { kind: "pending", op: "advance", opKey, input: cursor.action.input } }, receipt));
      }
      return cursor.action.op === "drain" ? replayFinalDrain(cursor, producer ??
        (observed?.runId && terminalAnalysis(observed, ref) ? { ...ref, runId: observed.runId } : null))
        : replayCursorAdmission({ ...cursor, halt: null }, committedAdvance,
          { ...ref, committed: !!cursor.halt || !!producer ||
            terminalAnalysis(observed, { ...ref, runId: observed?.runId }) });
    });
  }
  if (["timeout", "reviewer-renewal-barrier"].includes(cursor.halt?.stage) &&
      reviewerTimeoutAction(cursor.action) && !cursor.hostHalt)
    return replayReviewerTimeout(cursor);
  if (cursor.action.kind === "pending" && cursor.action.op === "gate" &&
      (cursor.halt?.stage === "timeout" || Object.hasOwn(gateRenewalBarriers, cursor.halt?.stage)) &&
      !cursor.hostHalt)
    return /\.acceptance(?:\.g[23])?\.gate$/.test(cursor.action.opKey)
      ? replayFinalGateTimeout(cursor) : replayGateTimeout(cursor);
  // A lost cursor advance can retain the committed gate action after the
  // result settled. Recover the completed review rather than running the gate.
  if (cursor.action.kind === "pending" && cursor.action.op === "gate" &&
      cursor.loop?.attempt?.stage === "result" && !cursor.halt && !cursor.hostHalt) {
    const synthesisKey = cursor.action.opKey.replace(/\.gate$/, ".task-synthesis");
    const synthesis = cursor.review?.slots.find(slot => slot.key === synthesisKey && slot.phase === "reviewer");
    if (synthesis?.runId)
      return replayCursorAdmission({ ...cursor, action: { kind: "launched", role: "reviewer",
        key: synthesis.key, runId: synthesis.runId, input: cursor.action.input } });
  }
  // A transport exception after dispatch is not an undispatched worker or a native Stop.
  let interruptedWorker = cursor.action.kind === "launched" && cursor.action.role === "worker" &&
    cursor.halt?.stage === "recovery" &&
    !cursor.hostHalt;
  if (interruptedWorker) cursor = { ...cursor, halt: null };
  // dispatch retains a sealer here only when its native response was active.
  // Re-observe that producer before interpreting a seal file as settled work.
  const reviewSealerKey = cursor.action.kind === "launched" && cursor.action.role === "reviewer" &&
    cursor.action.key.endsWith(".task-synthesis")
    ? `${cursor.action.key.slice(0, -".task-synthesis".length)}.seal` : null;
  const activeSealer = cursor.inFlight.find(ref => ref.role === "checkpoint-sealer" &&
    (ref.key === reviewSealerKey || ref.key.startsWith(`${reviewSealerKey}.r`)));
  if (activeSealer && cursor.halt?.stage === "sealer-activity" &&
      !cursor.hostHalt) {
    return observeStatus(activeSealer.runId, true).then(observed => {
      const cause = observed?.state === "unknown" ? null : barrier(observed, activeSealer.runId);
      if (["stopped", "interrupted", "native permission denial"].includes(cause)) {
        if (observed?.runId && observed.runId !== activeSealer.runId ||
            observed?.key && ![activeSealer.key, activeSealer.runId].includes(observed.key) ||
            observed?.agent && observed.agent !== "pitako.checkpoint-sealer")
          throw new Error("Sealer activity producer integrity mismatch.");
        const halt = closingInterruptionHalt(activeSealer, cause);
        return persistState(stateKey, { ...cursor, halt: { stage: "native-barrier", digest: canonicalDigest(halt) } })
          .then(() => ({ retainedReviewHalt: halt }));
      }
      if (cause) throw nativeBarrier(cause, activeSealer);
      if (observed?.runId && observed.runId !== activeSealer.runId ||
          observed?.agent && observed.agent !== "pitako.checkpoint-sealer")
        throw new Error("Sealer producer/run identity conflicts with the pending seal.");
      if (observed?.runId !== activeSealer.runId && !managementAnalysisState(observed, activeSealer) ||
          !terminalAnalysis(observed, activeSealer))
        throw new Error("Sealer activity has no exact terminal observation; no replacement dispatch.");
      return replayCursorAdmission({ ...cursor, halt: null });
    });
  }
  if (cursor.action.kind === "launched" && cursor.action.role === "reviewer" &&
      (cursor.action.key.endsWith(".compliance") ||
        cursor.loop?.phase === "closing" && cursor.action.runId && cursor.action.key.endsWith(".director-synthesis")) &&
      !cursor.halt && !cursor.hostHalt)
    return replayClosingCursor(cursor);
  if (retainedAction.kind === "launched" && retainedAction.role === "reviewer" && retainedAction.runId &&
      retainedAction.key.endsWith(".director-synthesis") && !cursor.loop?.taskId &&
      ["review", "compliance"].includes(cursor.loop?.phase) && !cursor.halt && !cursor.hostHalt)
    return replayFinalReview(cursor);
  if (cursor.action.kind === "launched" && cursor.action.role === "reviewer" &&
      /\.task-(reviewer|synthesis)$/.test(cursor.action.key) &&
      ["checkpoint-integrity", "native-barrier"].includes(cursor.halt?.stage) &&
      !cursor.hostHalt)
    return replayTaskReviewHalt(cursor).then(halt => ({ retainedReviewHalt: halt }));
  if (cursor.halt && !["recovery", "timeout"].includes(cursor.halt.stage))
    throw new Error(`Retained ${cursor.halt.stage} original integrity failure; no replay or dispatch.`);
  const reviewAction = cursor.action;
  const reviewRecovery = cursor.action.kind === "launched" && cursor.action.role === "reviewer" &&
    /\.task-(reviewer|synthesis)$/.test(cursor.action.key) && cursor.loop?.phase === "implementation" &&
    !cursor.halt && !cursor.hostHalt;
  const base = reviewRecovery ? cursor.action.key.replace(/\.task-(reviewer|synthesis)$/, "") : null;
  const reviewedNative = new Map();
  let reviewAdmission, unadmittedReview;
  const inspectReviewAdmission = () => reviewAdmission ??= host(config.inspections[0]).then(observation => {
    if (text(observation.error)) throw new Error(observation.error);
    checkAdmissionBinding(observation);
    // Store failures still go to the existing deterministic recovery writer.
    if (!observation.storeFailure && !config.preliminaryStoreFailure) {
      capture(observation);
      replayAdmissionObservation = observation;
    }
    return observation;
  });
  const verifyReviewAdmission = reviewRecovery && cursor.budget.rejectedKeys.length
    ? inspectReviewAdmission() : Promise.resolve();
  return verifyReviewAdmission.then(() => reviewRecovery ? Promise.all((cursor.action.key.endsWith(".task-synthesis")
      ? ["reviewer", "synthesis"] : ["reviewer"]).filter(stage =>
        !cursor.budget.rejectedKeys.includes(canonicalDigest(`${base}.task-${stage}`))).map(stage => {
      const ref = cursor.review?.slots.find(ref => ref.key === `${base}.task-${stage}` && ref.phase === "reviewer");
      if (!ref) throw new Error("Missing task review recovery producer.");
      function settled(observed, producer) {
        const cause = analysisBarrier(observed, producer.runId ?? producer.key);
        if (cause) throw nativeBarrier(cause, producer);
        if (!observed?.ok || !text(observed.runId) || producer.runId && observed.runId !== producer.runId ||
            !observed.structuredOutput && !analysisSettled(observed, producer) ||
            observed.key && ![producer.key, observed.runId].includes(observed.key) ||
            observed.agent && pitakoAgentFamily(observed.agent) !== "reviewer")
          throw new Error("Task review recovery producer identity or settlement integrity mismatch.");
        reviewedNative.set(ref.key, { agent: observed.agent,
          ...(observed.structuredOutput ? { digest: canonicalDigest(clone(observed.structuredOutput)) } : {}) });
        return { key: ref.key, runId: observed.runId };
      }
      return observeStatus(ref.runId ?? ref.key, true).then(observed => {
        if (ref.key !== reviewAction.key || reviewAction.runId !== null || ref.runId !== null ||
            ref.digest !== null || observed?.state !== "unknown" ||
            !/(?:^|\n| failed: )(?:Async run not found\. Provide id or dir\.|Run not found\. Provide id or runId\.)$/.test(observed.output))
          return settled(observed, ref);
        // Key-only status cannot distinguish absence from admission by a prior root.
        return inspectReviewAdmission().then(observation => {
          if (observation.storeFailure || config.preliminaryStoreFailure) capture(observation);
          const native = config.recovery?.references?.find(item => item.key === ref.key);
          if (text(native?.runId)) {
            const producer = { key: ref.key, runId: native.runId };
            return observeStatus(producer.runId, true).then(observed => settled(observed, producer));
          }
          if (native?.runId !== null)
            throw new Error("Task review recovery producer identity or settlement integrity mismatch.");
          unadmittedReview = true;
          retainedAnalysisDeadline = { key: ref.key, ms: cursor.timeouts.reviewerMs };
          return null;
        });
      });
    })).then(refs => refs.filter(Boolean)) : Promise.resolve(null)).then(reviewRefs => {
  if (reviewRecovery) {
    cursor = clone(cursor);
    const worker = cursor.review?.slots.find(ref => ref.key === base && ref.phase === "worker");
    if (!worker?.runId) throw new Error("Missing task review worker producer.");
    cursor.inFlight.push({ key: worker.key, runId: worker.runId, role: "worker" });
    cursor.action = { kind: "pending", op: "gate", opKey: `${base}.gate`, input: cursor.action.input };
    cursor.loop.attempt = { ...cursor.loop.attempt, number: Number(base.match(/\.a(\d+)$/)[1]), stage: "launched" };
  }
  const action = cursor.action;
  const pendingBaseline = action.kind === "pending" && action.op === "baseline" &&
    cursor.loop?.phase === "implementation" && ["intention", "launched"].includes(cursor.loop.attempt?.stage) &&
    action.opKey === `${key}.l${cursor.loop.number}.t${cursor.loop.cursor + 1}.a${cursor.loop.attempt.number}.baseline` &&
    !cursor.halt && !cursor.hostHalt;
  const retainedWorker = action.kind === "pending" && ["close", "gate"].includes(action.op)
    ? cursor.inFlight.find(ref => ref.role === "worker" && [ `${ref.key}.${action.op}`,
      ...[2, 3].map(generation => `${ref.key}.g${generation}.${action.op}`) ].includes(action.opKey)) : null;
  const pendingGate = action.kind === "pending" && action.op === "gate";
  const savedGate = pendingGate && !retainedWorker &&
    cursor.loop?.phase === "implementation" && cursor.loop.attempt?.stage === "launched" &&
    cursor.loop.outcome === null && !cursor.halt && !cursor.hostHalt;
  const pendingClose = action.kind === "pending" && action.op === "close" &&
    cursor.loop?.phase === "implementation" && cursor.loop.attempt?.stage === "launched" &&
    cursor.loop.outcome === null && !cursor.halt && !cursor.hostHalt;
  if (pendingClose && !retainedWorker && !observedGrouped.committed &&
      cursor.budget.rejectedKeys.includes(canonicalDigest(action.opKey))) {
    // A complete worker may have already committed its gate before the close was denied.
    const gateKey = action.opKey.replace(/\.close$/, ".gate");
    return replayCursorAdmission({ ...cursor,
      action: { ...action, op: "gate", opKey: gateKey } });
  }
  let pendingCloseReplay = false;
  let uncertainFirstWorker = false;
  let interruptedBaseline, observedWorker;
  let worker = pendingBaseline ? { key: action.opKey.slice(0, -".baseline".length), runId: null } : retainedWorker ?? action;
  return (pendingClose && retainedWorker && cursor.loop.attempt.number > 1
    ? observeStatus(action.opKey, true).then(observed => {
      const cause = barrier(observed, action.opKey);
      if (cause) throw nativeBarrier(cause, action);
      const metadata = observed?.output?.split("\n") ?? [];
      const completed = ["passed", "completed", "complete"].includes(observed?.state) ||
        metadata[0] === `Run: ${observed?.runId}` &&
          /^State: (complete|completed|passed)$/.test(metadata.find(line => line.startsWith("State: ")) ?? "");
      pendingCloseReplay = !observed?.ok || !completed;
  }) : Promise.resolve()).then(() => action.kind === "launched" && action.role === "worker" &&
    ["selection", "baseline"].includes(action.op) && worker.runId && !cursor.halt && !cursor.hostHalt
    ? observeStatus(worker.runId, true).then(observed => {
      observedWorker = observed;
      const cause = barrier(observed, worker.runId);
      if (cause !== "interrupted" && !interruptedWorker) return;
      assertFallbackProducer(observed, worker);
      if (observed?.key && ![worker.key, worker.runId].includes(observed.key))
        throw new Error("Execute worker replay producer mismatch.");
      if (nativeTimeout(observed))
        throw new Error("Retained restoration reports a native timeout; no baseline replay authorized.");
      // Rebuild the checkpoint-first path from the committed baseline, not
      // a worker output the interruption may have prevented from publishing.
      if (!observed?.ok || !observed.structuredOutput) {
        interruptedWorker = true;
        interruptedBaseline = { ...nativeReference(worker.key, observed), agent: "pitako.worker",
          runId: worker.runId, launchedMs: cursor.timeouts.workerMs };
      }
    })
    : action.kind === "launched" && action.role === "worker" && !worker.runId
    ? observeStatus(worker.key, true).then(observed => {
    const cause = barrier(observed, worker.key);
    if (cause === "interrupted" && !cursor.halt && !cursor.hostHalt) {
      assertFallbackProducer(observed, { key: worker.key });
      if (observed.key && ![worker.key, observed.runId].includes(observed.key))
        throw new Error("Execute worker replay producer mismatch.");
      if (barrier({ ...observed, interrupted: false, state: observed.state === "interrupted" ? undefined : observed.state,
        results: observed.results?.map(item => ({ ...item, interrupted: false })) }, worker.key) === "stopped")
        throw nativeBarrier("stopped", worker);
      // The original launch settled by interruption. Reconstruct its intent,
      // but never redispatch that worker key as if this were a pre-launch cut.
      interruptedWorker = true;
      return;
    }
    if (cause) throw nativeBarrier(cause, worker);
    if (text(observed?.runId) && observed.ok && !["running", "queued", "pending"].includes(observed.state)) {
      if (observed.agent && observed.agent !== "pitako.worker")
        throw new Error("Execute worker replay producer mismatch.");
      worker = { ...worker, runId: observed.runId };
      inFlight.set(worker.key, { key: worker.key, runId: worker.runId, role: "worker" });
    } else if (action.op === "selection") {
      if (observed?.agent && observed.agent !== "pitako.worker" ||
          observed?.key && ![worker.key, observed.runId].includes(observed.key))
        throw new Error("Execute worker replay producer mismatch.");
      uncertainFirstWorker = true;
    }
  }) : Promise.resolve()).then(() => {
  const undispatchedWorker = pendingBaseline || pendingCloseReplay || action.kind === "launched" && action.role === "worker" &&
    (!worker.runId || interruptedBaseline) &&
    cursor.loop?.phase === "implementation" && cursor.loop.attempt?.stage === "launched" &&
    ["selection", "baseline", "close"].includes(action.op) && !cursor.halt && !cursor.hostHalt &&
    worker.key === `${key}.l${cursor.loop.number}.t${cursor.loop.cursor + 1}.a${cursor.loop.attempt.number}`;
  const workerLaunch = !undispatchedWorker && (action.kind === "launched" && action.role === "worker" || retainedWorker) &&
    cursor.loop?.phase === "implementation" && cursor.loop.attempt?.stage === "launched" &&
    text(worker.runId) &&
    !cursor.halt && !cursor.hostHalt &&
    worker.key === `${key}.l${cursor.loop.number}.t${cursor.loop.cursor + 1}.a${cursor.loop.attempt.number}`;
  const retryDirector = observedGrouped?.retryDirector;
  const directorLaunch = action.kind === "launched" && isCurrentDirector(cursor, action) && action.runId === null &&
    (!action.key.endsWith(".d1") || retryDirector);
  // COMMIT may have advanced the store while the cursor still names the last close.
  const committedTransition = action.kind === "pending" && action.op === "close" &&
    cursor.loop?.outcome === "gaps" && cursor.budget.consumedLoops < cursor.budget.maxCycles;
  const closedReceipt = pendingClose && !retainedWorker;
  if (!(action.kind === "pending" && action.op === "advance") && !selectionReplay && !directorLaunch && !committedTransition && !workerLaunch && !undispatchedWorker && !closedReceipt && !savedGate)
    return Promise.reject(new Error(`Recorded execute action has no admitted root projection: ${action.kind} ${action.op ?? action.role} ${action.opKey ?? action.key} (halt=${cursor.halt?.stage ?? "none"}, hostHalt=${cursor.hostHalt?.stage ?? "none"}).`));
  const transitionKey = `${key}.l${cursor.loop?.number}.nextAdvance`;
  const operation = pendingGate ? "gate" : workerLaunch || closedReceipt ? "close" : undispatchedWorker ? action.op : "advance";
  const input = reviewRecovery ? { operation: "gate", root: cursor.root, invocation: cursor.invocation,
    key: reviewRefs.length ? `${reviewRefs.at(-1).key}.review-recovery` : `${base}.review-context-recovery`,
    storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`,
    expectedHead: cursor.head, refs: { input: action.input, reviewRecovery: reviewRefs } }
    : workerLaunch ? storedWorkerCloseInput({ ...cursor, intent: cursor.loop.attempt.intent,
    gateFloorMs: cursor.timeouts.gateFloorMs }, worker, action.input, operation)
    : { operation, root: cursor.root, invocation: cursor.invocation,
    ...(!directorLaunch && !undispatchedWorker ? { key: committedTransition ? transitionKey : action.opKey } : {}),
    storeId: cursor.storeId, scope: `exec:${cursor.invocation}.e${cursor.epoch}`,
    expectedHead: cursor.head, refs: { input: action.input, ...(retryDirector ? { retryDirector } : {}),
      ...((uncertainFirstWorker || interruptedBaseline) && undispatchedWorker && operation === "selection"
        ? { uncertainWorker: cursor.loop.attempt.intent,
          ...(worker.runId ? { worker: { key: worker.key, runId: worker.runId } } : {}) } : {}),
      ...(pendingCloseReplay ? { intent: cursor.loop.attempt.intent,
        worker: { key: worker.key, runId: worker.runId } } : {}) } };
  const replayKey = committedTransition ? transitionKey : directorLaunch ? `${action.key}.advance-replay` : action.opKey;
  const recoveringWorker = workerLaunch && action.kind === "launched";
  if (recoveringWorker) input.key = `${worker.key}.recover`;
  const committedCloseReplay = pendingClose && !pendingCloseReplay &&
    (observedGrouped?.committed || cursor.loop.attempt.number > 1 || closedReceipt);
  if (committedCloseReplay) input.refs.committed = true;
  if (savedGate) input.refs.committed = true;
  const observePendingGate = (retry = 0, committed = false) => {
    if (!workerLaunch || !pendingGate || reviewRecovery) return Promise.resolve(null);
    const childKey = retry ? `${action.opKey}.r${retry}` : action.opKey;
    if (cursor.budget.rejectedKeys.includes(canonicalDigest(childKey)))
      return Promise.resolve({ childKey, committed, retry });
    return observeStatus(childKey, true).then(observed => {
      const cause = analysisBarrier(observed, childKey);
      if (cause) throw nativeBarrier(cause, { key: childKey, runId: observed.runId });
      if (observed?.agent && pitakoAgentFamily(observed.agent) !== "loop-io" ||
          observed?.key && ![childKey, observed.runId].includes(observed.key))
        throw new Error("Gate replay producer identity mismatch.");
      const ref = { key: childKey, runId: observed?.runId };
      if (!observed?.runId) return { childKey, committed, retry };
      const passed = terminalLoopIOResult(observed, childKey, "gate") ||
        analysisSettled(observed, ref);
      if (!nativeTimeout(observed) && terminalAnalysis(observed, ref) && retry < 2)
        return observePendingGate(retry + 1, committed || passed);
      throw new Error(`Gate replay lacks an available retry for ${childKey}.`);
    });
  };
  let settledReviewSealer, retiredReviewSealer;
  const observeReviewSealer = () => {
    if (reviewRefs?.length !== 2) return;
    const seal = `${base}.seal`;
    const ref = cursor.inFlight.findLast(ref => ref.role === "checkpoint-sealer" &&
      ref.key.replace(/\.r\d+$/, "") === seal) ?? { key: seal };
    if (cursor.budget.rejectedKeys.includes(canonicalDigest(ref.key))) return;
    return observeStatus(ref.runId ?? ref.key, true).then(observed => {
      if (observed?.state === "unknown") return; // Unknown is not settlement or a positive barrier.
      const cause = analysisBarrier(observed, ref.runId ?? ref.key);
      if (cause) throw nativeBarrier(cause, ref);
      if (observed?.runId && ref.runId && observed.runId !== ref.runId ||
          observed?.key && ![ref.key, ref.runId, observed.runId].includes(observed.key) ||
          observed?.agent && observed.agent !== "pitako.checkpoint-sealer")
        throw new Error("Task review sealer recovery producer identity mismatch.");
      if (ref.runId && (observed?.runId === ref.runId || managementAnalysisState(observed, ref))) {
        if (terminalAnalysis(observed, ref)) retiredReviewSealer = ref.key;
        if (analysisSettled(observed, ref)) settledReviewSealer = ref.key;
      }
    });
  };
  const childKey = reviewRecovery ? `${input.key}.r1` :
    pendingCloseReplay ? `${worker.key}.pending-close-replay.r1` :
    undispatchedWorker ? `${worker.key}.${operation}-replay.r1` : recoveringWorker ? `${worker.key}.recover.r1` :
    committedCloseReplay ? `${action.opKey}.r${Number(observedGrouped?.key?.match(/\.r(\d+)$/)?.[1] ?? 0) + 1}` :
    workerLaunch ? `${worker.key}.${operation}` : closedReceipt ? action.opKey : `${replayKey}.r1`;
  return (committedAdvance ? Promise.resolve({ receipt: committedAdvance }) : (workerLaunch ?
    (observedWorker === undefined ? observeStatus(worker.runId, true) : Promise.resolve(observedWorker)).then(observed => {
    const cause = barrier(observed, worker.runId);
    if (cause) throw nativeBarrier(cause, worker);
    if (observed?.runId && observed.runId !== worker.runId ||
        observed?.key && ![worker.key, worker.runId].includes(observed.key) ||
        observed?.agent && observed.agent !== "pitako.worker")
      throw new Error("Execute worker replay producer mismatch.");
  }) : Promise.resolve()).then(observeReviewSealer).then(() => observePendingGate()).then(gate => {
    if (gate?.committed) input.refs.committed = true;
    return replayLoopIO(gate?.childKey ?? childKey, input, workerLaunch ? action.gateTimeoutMs : undefined,
      unadmittedReview ? 0 : gate ? 2 - gate.retry : undefined);
  })).then(({ receipt, result, childKey: replayedKey }) => {
    if (pendingGate) receipt = readTaskGateWire(receipt, receipt.gateTask?.gates ?? receipt.P?.prompt.selectedTask?.gates,
      receipt.P?.prompt.execution?.worker?.reference);
    if (reviewRecovery && receipt?.committedAdvance) {
      const advance = receipt.committedAdvance;
      const operation = advance.P?.control.operation;
      if (operation?.operation !== "advance" || operation.key !== `${key}.l${cursor.loop.number}.nextAdvance` ||
          operation.loop !== cursor.loop.number + 1 || advance.storeId !== cursor.storeId)
        throw new Error("Task review committed advance position integrity mismatch.");
      // Rebuild the committed transition locally; never reissue its native key with new params.
      return replayCursorAdmission({ ...cursor, head: advance.head,
        action: { kind: "pending", op: "advance", opKey: operation.key, input: operation.input },
        loop: { ...cursor.loop, outcome: "gaps", attempt: null } }, advance);
    }
    const restorationBaseline = !pendingBaseline && !pendingCloseReplay && action.role === "worker" &&
      receipt.replayOperation === "baseline" &&
      receipt.P?.prompt.execution?.checkpoint?.attempt === cursor.loop.attempt.number + 1;
    const replayedBaseline = restorationBaseline ||
      undispatchedWorker && (operation === "baseline" || receipt.replayOperation === "baseline");
    const replayedClose = undispatchedWorker && operation === "close";
    if (uncertainFirstWorker && receipt.checkpointCaptured) interruptedWorker = true;
    if (!pendingGate && !replayedBaseline) receiptReference(receipt);
    const admission = receipt.P?.prompt.admission;
    if (selectionReplay && (cursor.action.kind === "pending" && cursor.action.op === "selection"
        ? (receipt.selectionCancellation ? receipt.head.seq < cursor.head.seq : !same(receipt.head, cursor.head)) ||
          !same(receipt.P?.control.operation?.input, cursor.action.input)
        : receipt.head?.seq <= cursor.head.seq))
      throw new Error("Selection replay receipt differs from its committed head.");
    if (selectionReplay && (receipt.P?.control.operation?.operation !== "selection" ||
        receipt.P.control.operation.key !== selectionReplay))
      throw new Error("Selection replay receipt differs from its committed operation.");
    let execution = receipt.P?.prompt.execution;
    let continuation = execution?.continuation;
    if (restorationBaseline) {
      const source = worker;
      worker = { key: source.key.replace(/\.a\d+$/, `.a${cursor.loop.attempt.number + 1}`), runId: null };
      if (continuation?.attempt.restore?.producer.key !== source.key ||
          (continuation.attempt.restore.producer.runId ?? null) !== (source.runId ?? null))
        throw new Error("Execute restoration replay differs from its source producer.");
      inFlight.delete(source.key);
    }
    const closedPacket = pendingClose && !pendingCloseReplay ? execution?.foldedContinuation : null;
    if (pendingClose && !pendingCloseReplay && closedPacket?.attempt.number !== cursor.loop.attempt.number)
      throw new Error(`Committed close continuation integrity mismatch: expected attempt ${cursor.loop.attempt.number}, observed ${closedPacket?.attempt.number ?? "missing"}.`);
    if (closedPacket && closedPacket.attempt.number === cursor.loop.attempt.number) {
      execution = { ...execution, checkpoint: closedPacket.attempt.checkpoint, worker: closedPacket.worker };
      continuation = closedPacket;
    }
    if (closedReceipt || savedGate) worker = {
      key: action.opKey.replace(/(?:\.g[23])?\.(close|gate)$/, ""), runId: execution?.worker?.reference.runId };
    const workerPosition = workerLaunch || undispatchedWorker || closedReceipt || savedGate;
    if ((workerLaunch || undispatchedWorker) && cursor.loop.attempt.number > 1 &&
        !continuation && !execution?.foldedContinuation)
      throw new Error("Execute worker continuation reference integrity mismatch.");
    const prepared = selectionReplay || undispatchedWorker && operation === "selection" && !replayedBaseline ? groupedStep(receipt, "apply") : workerPosition ? {
      selected: receipt.P.prompt.selectedTask, digest: cursor.backlogDigest,
      view: replayedBaseline ? continuation?.view : pendingGate ? receipt.view : receipt.projection.view,
    } : groupedStep(receipt, "prepare");
    const preparedNumber = selectionReplay ? cursor.loop.number
      : workerPosition ? execution?.checkpoint?.loop : receipt.P?.control.operation?.loop;
    const directorPosition = cursor.loop?.phase === "director" && !cursor.loop.attempt &&
      preparedNumber === cursor.loop.number;
    const nextLoopPosition = cursor.loop?.outcome === "gaps" &&
      preparedNumber === cursor.loop.number + 1 &&
      cursor.budget.consumedLoops < cursor.budget.maxCycles;
    if (!admission || canonicalDigest(admission.association) !== cursor.associationDigest ||
        admission.admissionBinding !== cursor.admissionBinding ||
        admission.association.maxCycles !== cursor.budget.maxCycles ||
        receipt.storeId !== cursor.storeId || !(directorPosition || nextLoopPosition || workerPosition && preparedNumber === cursor.loop.number) ||
        cursor.halt || cursor.hostHalt)
      throw new Error("Execute replay lacks its bound admission and unimpeded director position.");
    const requests = replayedBaseline ? continuation?.requests :
      pendingGate ? { requests: [], next: null } : groupedStep(receipt, workerLaunch || closedReceipt || replayedClose ? "nextRequests" : "requests");
    if ((requests.requests.length || requests.next !== null) && !receipt.P.prompt.transition && !selectionReplay)
      throw new Error("Execute advance replay requires reconciliation of its committed request page.");
    const { view, ...prepareReceipt } = prepared;
    storeProjection = { head: receipt.head, P: receipt.P };
    if (workerLaunch && !recoveringWorker && !reviewRecovery && inFlight.get(worker.key)?.runId === worker.runId)
      inFlight.delete(worker.key);
    const restoredLoop = { number: preparedNumber,
      startedAt: committedLoopOpen(preparedNumber, receipt.P) ?? admission.startedAt, phase: "director",
      cursor: 0, manifest: null, plan: null, attempt: null, results: [], recoveries: [], usage: [],
      prepare: { stage: "receipt", receipt: prepareReceipt },
      ...(!pendingGate && !replayedBaseline ? { advance: { key: receipt.P.control.operation.key, stage: "receipt", retry: 0,
        admitted: true, receipt: receiptReference(receipt) } } : {}) };
    const retryContext = retryDirector && receipt.retryDirector;
    if (retryDirector) {
      const { plan, rejection, requestObservation, ...context } = retryContext ?? {};
      if (!same(receipt.head, cursor.head) || !text(rejection?.diagnostic) ||
          (retryDirector.runId === null ? plan !== undefined :
            plan?.ref?.key !== retryDirector.key || plan.ref.runId !== retryDirector.runId))
        throw new Error("Director replay lacks its exact retry selection context.");
      Object.assign(restoredLoop, context, { plan: plan ?? null, directorRetry: rejection });
    }
    if (selectionReplay) Object.assign(restoredLoop, {
      plan: clone(execution.plan), usage: clone(execution.usage),
      ...(execution.recoveries ? { recoveries: clone(execution.recoveries) } : {}),
      ...(execution.checkpoint ? { initialCheckpoint: clone(execution.checkpoint) } : {}),
      replayedSelection: receipt,
    });
    if (workerPosition) {
      const checkpoint = execution?.checkpoint;
      const intent = committedIntentReference(reviewRecovery ? {
        seq: receipt.P.control.intent.seq, digest: receipt.P.control.intent.digest,
      } : replayedBaseline ? receipt.intent : cursor.loop.attempt.intent, receipt.head);
      if (checkpoint?.key !== worker.key || checkpoint.taskId !== cursor.loop.taskId ||
          checkpoint.attempt !== cursor.loop.attempt.number + (restorationBaseline ? 1 : 0) ||
          prepared.selected?.id !== checkpoint.taskId ||
          !execution.plan?.ref || !undispatchedWorker && !restorationBaseline && (!execution.worker?.value ||
          execution.worker.reference.key !== worker.key || execution.worker.reference.runId !== worker.runId))
        throw new Error("Execute worker replay lacks its committed selection and intent.");
      const { selected, completedTasks, ...selection } = prepared;
      Object.assign(restoredLoop, {
        usage: clone(execution.usage ?? []),
        phase: "implementation", cursor: cursor.loop.cursor, kind: "task", task: selected,
        taskBacklogDigest: prepared.digest, metricSeries: clone(selected.progress ?? { nonImproving: 0, last5: [] }),
        manifest: [selected.id], plan: { ...execution.plan, stage: "admitted" },
        selection: { stage: "receipt", receipt: { ...selection, selected: selected.id,
          ...(!pendingGate && !replayedBaseline ? { groupedReference: receiptReference(receipt) } : {}) } },
        attempt: { taskId: selected.id, index: cursor.loop.cursor, number: checkpoint.attempt, key: worker.key,
          stage: undispatchedWorker || restorationBaseline ? "intention" : "launched", intent, checkpoint, baseline: checkpoint.baseline,
          bindingKey: worker.key, timeoutMs: cursor.timeouts.workerMs,
          ...(undispatchedWorker || restorationBaseline ? { undispatched: true, continuationRef: continuation?.attempt.continuationRef ?? null,
            foldedBaseline: { checkpoint, intent } } : {
          launch: { key: worker.key, agent: "pitako.worker", runId: worker.runId,
            outputReference: execution.worker.reference.path },
          received: { ok: true, agent: "pitako.worker", key: worker.key, runId: worker.runId,
            structuredOutput: execution.worker.value } }),
          ...(pendingGate ? { gate: { key: action.opKey, stage: "receipt", retry: 0,
            ref: nativeReference(childKey, result),
            receipt: Object.fromEntries(Object.entries(receipt).filter(([key]) => !["head", "P", "storeId"].includes(key))) } } :
            recoveringWorker && execution.worker?.value.status === "complete" ? {
              gate: { key: `${worker.key}.gate`, stage: "intention", retry: 0,
                gateFloorMs: cursor.timeouts.gateFloorMs, task: {
                  id: selected.id, gates: selected.gates.map(gate => ({ ...gate,
                    timeoutMs: Math.max(gate.timeoutMs ?? 1800000, cursor.timeouts.gateFloorMs) })),
                  metric: selected.metric ?? null,
                  progress: clone(selected.progress ?? { nonImproving: 0, last5: [] }) } } } :
            !recoveringWorker && !undispatchedWorker && !restorationBaseline ? { close: { key: childKey, stage: "receipt", retry: 0, admitted: true,
            ref: nativeReference(childKey, result), receipt } } : {}) },
      });
      restoredLoop.plan.association = { ...admission.association, loop: preparedNumber };
      delete restoredLoop.advance;
      if (continuation) {
        if (continuation.attempt.key !== worker.key || continuation.attempt.number !== checkpoint.attempt)
          throw new Error("Execute worker continuation differs from its committed intent.");
        restoredLoop.results = clone(continuation.results);
        restoredLoop.recoveries = clone(continuation.recoveries);
        restoredLoop.usage = clone(continuation.usage ?? execution.usage ?? []);
        restoredLoop.metricSeries = clone(continuation.metricSeries);
        restoredLoop.attempt = { ...clone(continuation.attempt), ...restoredLoop.attempt };
        if (workerLaunch && !restorationBaseline) {
          delete restoredLoop.attempt.undispatched;
          if (restoredLoop.attempt.restore) delete restoredLoop.attempt.restore.undispatched;
        }
        if (continuation.attempt.revival) restoredLoop.attempt.revival = clone(continuation.attempt.revival);
      }
      if (interruptedWorker && undispatchedWorker && !restorationBaseline) {
        restoredLoop.attempt.stage = "launched";
        restoredLoop.attempt.launch = interruptedBaseline ?? { key: worker.key, agent: "pitako.worker" };
        delete restoredLoop.attempt.undispatched;
        if (restoredLoop.attempt.restore) delete restoredLoop.attempt.restore.undispatched;
      }
      if (savedGate) {
        restoredLoop.metricSeries = clone(receipt.progress);
        restoredLoop.attempt.boardPostIds = clone(receipt.boardPostIds);
        restoredLoop.attempt.gate.task = clone(receipt.gateTask);
      }
      if (pendingGate && receipt.reviewContext) restoredLoop.attempt.delta = {
        key: `${worker.key}.delta`, retry: 0, stage: "receipt", receipt: clone(receipt.reviewContext.delta),
      };
      if (reviewRecovery) {
        restoredLoop.taskReviewCursor = clone(cursor.review);
        restoredLoop.metricSeries = clone(receipt.progress);
        const originals = execution.taskReviewRecovery?.originals;
        if (!originals || originals.length !== reviewRefs.length) throw new Error("Missing recovered task review originals.");
        restoredLoop.attempt.taskReview = {};
        restoredLoop.analysisCalls = originals.map(({ reference, agent, body }, index) => {
          const observed = reviewedNative.get(reference.key);
          const producerAgent = agent ?? observed?.agent;
          if (reference.key !== reviewRefs[index].key || reference.runId !== reviewRefs[index].runId ||
              canonicalDigest(body) !== reference.digest ||
              observed?.digest && observed.digest !== reference.digest ||
              observed?.agent && observed.agent !== producerAgent ||
              producerAgent && pitakoAgentFamily(producerAgent) !== "reviewer")
            throw new Error("Task review recovery original integrity mismatch.");
          restoredLoop.attempt.taskReview[index ? "synthesis" : "reviewer"] = clone(reference);
          const original = { ok: true, key: reference.key, agent: producerAgent,
            runId: reference.runId, structuredOutput: body, results: [{ savedOutputPath: reference.path }] };
          analysisResults.set(reference.key, original);
          return { key: reference.key, stage: "receipt", ref: nativeReference(reference.key, original) };
        });
        restoredLoop.attempt.reviewRecovered = true;
        if (cursor.budget.consumedLoops === cursor.budget.maxCycles && originals.length === 2)
          restoredLoop.replayedDrainAnchor = { head: clone(cursor.head), input: clone(cursor.action.input) };
        restoredLoop.attempt.delta = { key: `${worker.key}.delta`, retry: 0, stage: "receipt",
          receipt: clone(execution.taskReviewRecovery.delta) };
        restoredLoop.attempt.recoveredRequests = clone(execution.taskReviewRecovery.requests);
        restoredLoop.attempt.recoveryRef = nativeReference(childKey, result);
        if (execution.taskReviewRecovery.baseline)
          restoredLoop.attempt.foldedNextBaseline = clone(execution.taskReviewRecovery.baseline);
        for (const drain of execution.taskReviewRecovery.drains ?? []) {
          const slot = drain.key.slice(drain.key.lastIndexOf(".") + 1);
          restoredLoop[slot] = { key: drain.key, retry: 0, stage: "receipt", receipt: clone(drain) };
        }
      }
      if (pendingCloseReplay) {
        const original = receipt.recoveredWorker;
        if (original?.reference.key !== worker.key || original.reference.runId !== worker.runId)
          throw new Error("Pending close worker original integrity mismatch.");
        const id = `${original.reference.runId}:0`, reported = original.usage;
        if (!restoredLoop.usage.some(value => value.id === id)) restoredLoop.usage.push({ id,
          tokens: reported && ["input", "output", "cacheRead", "cacheWrite"].every(field =>
            Number.isFinite(reported[field]) && reported[field] >= 0)
            ? ["input", "output", "cacheRead", "cacheWrite"].reduce((total, field) => total + reported[field], 0) : null });
        Object.assign(restoredLoop.attempt, { stage: "launched", launch: { key: worker.key,
          agent: "pitako.worker", runId: worker.runId, outputReference: original.reference.path },
          boardPostIds: view.posts.map(post => post.id),
          received: { ok: true, agent: "pitako.worker", key: worker.key, runId: worker.runId,
            structuredOutput: original.value } });
        delete restoredLoop.attempt.undispatched;
        delete restoredLoop.attempt.close;
      }
      if (pendingClose && !pendingCloseReplay) {
        const gate = groupedStep(receipt, "gate");
        gate.receipt = readTaskGateWire(gate.receipt, selected.gates, gate.workerOriginal);
        restoredLoop.metricSeries = clone(gate.receipt.progress);
        restoredLoop.attempt.gate = { key: `${worker.key}.gate`, stage: "receipt",
          receipt: { ...gate.receipt, view: receipt.projection.view, contextPeak: gate.contextPeak } };
        restoredLoop.attempt.close.input = { operation: "close", refs: { input: receipt.P.control.operation.input } };
        if (closedPacket?.checkpoint.attempt === cursor.loop.attempt.number + 1) restoredLoop.attempt.foldedNextBaseline = {
          checkpoint: clone(closedPacket.checkpoint), intent: clone(closedPacket.intent) };
      }
      const consumingOp = (pendingCloseReplay ? receipt.recoveredWorker.value : execution.worker?.value)?.status === "complete" ? "gate" : "close";
      dispatchedAction = restorationBaseline ? undefined : recoveringWorker || pendingCloseReplay ? { kind: "pending", op: consumingOp,
        opKey: `${worker.key}.${consumingOp}`, gateTimeoutMs: action.gateTimeoutMs,
        ...(consumingOp === "gate" ? { gateTimeouts: prepared.selected.gates.map(gate => gate.timeoutMs ?? 1800000),
          gateMetricMs: prepared.selected.metric ? 1800000 : 0 } : {}) }
        : reviewRecovery ? clone(reviewAction)
        : (interruptedWorker) && undispatchedWorker ? clone(action) : undefined;
    }
    const restoredFrame = continuation ? clone(continuation.taskFrame) :
      { taskId: prepared.selected?.id, identities: [], evidence: [], operations: [], restorationKeys: [] };
    if (reviewRecovery) {
      const task = prepared.selected;
      const carried = !!task.remaining?.length || (task.progress?.last5?.length ?? 0) > 0 ||
        (task.progress?.nonImproving ?? 0) > 0;
      restoredFrame.reviewProjections ??= {};
      for (const { reference, body } of execution.taskReviewRecovery.originals) {
        const projection = taskReviewProjection(body, reference, carried);
        restoredFrame.reviewProjections[reference.key] = projection;
        if (reference.key.endsWith(".task-synthesis")) {
          if (!projection.admitted) restoredFrame.reviewRepair = {
            ...(restoredFrame.reviewRepair?.attempt ? { attempt: restoredFrame.reviewRepair.attempt } : {}),
            source: reference, exhausted: !!restoredFrame.reviewRepair?.attempt || projection.conflict };
          const observed = clone(execution.taskReviewRecovery.seal);
          const retainedSealer = cursor.inFlight.find(ref => ref.role === "checkpoint-sealer" &&
            (ref.key === sealerKey(worker.key, 0) || ref.key.startsWith(`${worker.key}.seal.r`)));
          if (!observed && !retainedSealer) continue;
          if (!observed && retainedSealer.key !== retiredReviewSealer)
            throw new Error("Task review sealer has no exact terminal observation; no replacement dispatch.");
          const retry = retainedSealer ? Number(retainedSealer.key.match(/\.r(\d+)$/)?.[1] ?? 0) + 1 : 1;
          restoredLoop.attempt.seal = { kind: projection.admitted ? "unit" : "pause", retry };
          if (!observed) continue;
          observed.kind ??= restoredLoop.attempt.seal.kind;
          if (observed.kind !== restoredLoop.attempt.seal.kind)
            throw new Error("Task review recovery seal differs from its original verdict.");
          // A file is not settlement evidence for a retained native producer.
          // Keep its intention so observePendingSealer checks activity before reuse.
          if (!retainedSealer || retainedSealer.key === settledReviewSealer)
            restoredLoop.attempt.recoveredSeal = { receipt: observed };
        }
      }
    }
    const restored = {
      version: config.stateVersion, association: admission.association, admissionBinding: admission.admissionBinding,
      amendments: admission.amendments, revivalContextPeak: admission.revivalContextPeak,
      taskReviewer: cursor.models.taskReviewer, taskSynthesis: cursor.models.taskSynthesis,
      reviewModels: Object.fromEntries(["r1", "r2", "synthesis"].map(slot => [
        slot, { key: `pitako.review.${slot}`, model: cursor.models[slot] },
      ])), timeouts: { values: clone(cursor.timeouts), since: null }, startedAt: admission.startedAt,
      consumedLoops: cursor.budget.consumedLoops + (nextLoopPosition ? 1 : 0), ledger: receipt.P.control.ledger,
      requestObservation: retryContext ? retryContext.requestObservation : receipt.P.control.requestObservation,
      ...(selectionReplay ? { lastRequestReceipt: receiptReference(receipt) } : {}),
      ...(receipt.reviewContext ? { requestObservation: receipt.reviewContext.requestObservation } : {}),
      ...(reviewRecovery ? { requestObservation: execution.taskReviewRecovery.observation?.number ??
        execution.taskReviewRecovery.requestObservation } : {}),
      budgetRejectedKeys: cursor.budget.rejectedKeys.filter(digest => digest !== canonicalDigest(replayedKey ?? childKey)),
      sealPending: null, recoverySeq: Math.max(0, ...restoredLoop.recoveries.map(recovery =>
        Number(recovery.ref.key.match(/\.recover(\d+)$/)?.[1] ?? 0))), lastRecoveryRef: null,
      ...(receipt.P.control.finishDrain?.key.startsWith(`${key}.l${restoredLoop.number}.finishDrain`) ? {
        finishDrain: { ...clone(receipt.P.control.finishDrain), admitted: true, stage: "receipt" },
      } : {}),
      lastConfirmed: receipt.admittedPause?.checkpoint ?? continuation?.lastConfirmed ?? receipt.P.control.lastConfirmed,
      ...(continuation ? { intentions: clone(continuation.intentions ?? []), lastRequestPage: clone(continuation.requests) } : {}),
      usageTotals: receipt.P.preview.usage,
      tasks: workerPosition ? { [prepared.selected.id]: continuation
        ? clone(continuation.taskState) : { admitted: [], completed: null, last: null } } : {},
      taskFrame: workerPosition ? restoredFrame : null, loop: restoredLoop,
      ...(execution?.foldedContinuation && !closedPacket ? { foldedContinuation: execution.foldedContinuation } : {}),
      ...(closedPacket ? { closedDrained: closedPacket.drained } : {}),
      planRejections: receipt.P.preview.planRejections, closeReferences: receipt.P.preview.closeReferences,
      loopSummaries: receipt.P.prompt.loopSummaries ?? receipt.P.preview.loopSummaries,
      activePlan: null,
      demandSources: receipt.P.prompt.demand?.sources ?? [],
      demandObservations: receipt.P.prompt.demand?.observations ?? [],
      root: cursor.root, epoch: cursor.epoch, head: receipt.head, storeId: receipt.storeId,
      receiptReference: reviewRecovery ? execution.taskReviewRecovery.receiptReference :
        replayedBaseline ? continuation.receiptReference ?? null :
        pendingGate ? savedGate ? receiptReference(receipt.receiptReference) : null : receiptReference(receipt),
      backlogDigest: prepared.digest, backlogPath: prepared.path ?? execution?.backlogPath,
      boardTopicId: view.topicId, currentView: view,
      excludedScope: Object.fromEntries((prepared.cancelledScope ?? []).map(task => [task.id, task])),
      ...(nextLoopPosition && receipt.P.prompt.transition ? {
         transitionReplay: { ...clone(receipt.P.prompt.transition), requests: clone(requests),
          receipt: receiptReference(receipt), number: cursor.loop.number },
      } : {}),
    };
    const demand = retryContext?.analysisCalls?.findLast(call =>
      call.key.endsWith(".demand-observation") && call.stage === "receipt" && !call.barrier);
    if (demand) {
      const ref = demand.ref;
      retainDemandObservation(restored, preparedNumber, nativeReference(ref.key, ref));
    }
    return restored;
  });
  });
  });
}
function checkEpochProducers(timeoutAction) {
  // The live map also includes producers admitted since the last cursor save.
  const refs = [...inFlight.values()];
  // Timeout receipts leave inFlight, but the bound producer can still expose a native barrier.
  if (timeoutAction?.runId && !refs.some(ref => ref.runId === timeoutAction.runId))
    refs.push(timeoutAction);
  return refs.reduce((chain, ref) => chain.then(() => timeoutAction
    ? observeReviewerTimeoutStatus(ref.runId) : observeStatus(ref.runId, true)).then(observed => {
    if (timeoutAction?.runId === ref.runId)
      checkReviewerTimeoutIdentity(observed, ref);
    const cause = (timeoutAction ? analysisBarrier : barrier)(observed, ref.runId);
    if (cause) throw nativeBarrier(cause, ref);
    if (observed?.runId !== ref.runId && !(observed?.runId === undefined && managementAnalysisState(observed, ref)) ||
        observed.agent && pitakoAgentFamily(observed.agent) !== pitakoAgentFamily(`pitako.${ref.role}`) ||
        !terminalAnalysis(observed, ref))
      throw new Error(`Store epoch recovery awaits exact terminal producer evidence for ${ref.key}.`);
  }), Promise.resolve());
}
function recoverStoreEpoch(error, cursor) {
  if (!["store-corrupt", "cursor-ahead", "store-replaced"].includes(error.code) ||
      !error.recovery?.storeId || error.recovery.root !== cursor.root) return false;
  if (cursor.hostHalt || cursor.halt && !["recovery", "timeout", "worker-activity"].includes(cursor.halt.stage))
    throw new Error("Store integrity failure at a retained terminal halt; no replay or dispatch.");
  // The native inspection key is single-use, including when replay failed before admission completed.
  const observation = error.epochAdmissionObservation ?? (admissionValidated
    ? { version: config.preliminary.version, binding: invocation.admissionBinding, checkout: currentCandidate }
    : inspectedEpochAdmission);
  return beginStoreEpoch(cursor, observation);
}
function beginStoreEpoch(cursor, observation, timeoutAction) {
  return checkEpochProducers(timeoutAction).then(() => {
    recoveredEpochCursor = clone(cursor);
    key = `invoke-${config.invocation}.e${cursor.epoch + 1}`;
    inFlight.clear();
    dispatchedAction = undefined;
    storeProjection = undefined;
    invocation = undefined;
    activePlan = null;
    loop = null;
    replay = admissionValidated = false;
    replayAdmissionObservation = observation;
    checkpointObservation = undefined;
    refreshedTimeoutAdmission = undefined;
    return true;
  });
}
while (true) {
let retainedCursor;
try {
  if (config.timeouts !== undefined && (!config.timeouts || typeof config.timeouts !== "object" ||
      Array.isArray(config.timeouts) || Object.entries(config.timeouts).some(([name, ms]) =>
        !["reviewerMs", "workerMs", "gateFloorMs"].includes(name) || !Number.isSafeInteger(ms) || ms < 1 || ms > 86400000)))
    return finish("blocked", "Expected timeouts {reviewerMs?, workerMs?, gateFloorMs?}: safe integers in 1..86400000, no unknown keys.");
  for (const argument of ["unblock", "resolution"])
    if (Object.hasOwn(config, argument)) return finish("blocked", `Unsupported execution argument: ${argument}.`);
  if (!text(config.missionId) || !text(config.missionPath) || !text(config.invocation))
    return finish("blocked", "Existing native missionId and actually returned missionPath are required.");
  retainedCursor = recoveredEpochCursor ? null : await state.get(stateKey);
  if (retainedCursor?.invocation === config.invocation) {
    if (retainedCursor.version !== config.stateVersion) {
      const reason = `${EXECUTE_CONTINUATION_INCOMPATIBLE}: Retained execution created by an incompatible Pitako contract v${retainedCursor.version}. No migration or replay is supported; retained unchanged.`;
      return { ...cursorDisposition(retainedCursor, "blocked", reason), code: EXECUTE_CONTINUATION_INCOMPATIBLE };
    }
    validateExecuteCursor(stateKey, retainedCursor);
    if (retainedCursor.root !== config.root)
      return cursorDisposition(retainedCursor, "blocked", "Execute cursor belongs to the wrong cwd.");
    if (retainedCursor.epoch > 0) key += `.e${retainedCursor.epoch}`;
    if (retainedCursor.hostHalt) {
      const { stage, reason, digest } = retainedCursor.hostHalt;
      if (!matchesCursorRequest(retainedCursor) || config.verifiedHostHalt !== canonicalDigest(clone(retainedCursor)) ||
          hostHaltCursor(retainedCursor, { stage, reason }).digest !== digest)
        return cursorDisposition(retainedCursor, "blocked", "Retained host halt integrity failure; no replay or dispatch.");
      return hostHaltDisposition(retainedCursor, hostHaltReport(retainedCursor.action, retainedCursor.hostHalt));
    }
    if (retainedCursor.action.kind === "terminal" && !retainedCursor.halt) {
      if (!matchesCursorRequest(retainedCursor))
        return cursorDisposition(retainedCursor, "blocked",
          "Immutable mission/invocation/snapshot/worktree association changed; retained unchanged. Restore reliable exact bytes.");
      try {
        // A terminal result still depends on the admitted chain and frozen amendments.
        const observed = await host(config.inspections[0]);
        if (observed.error) throw new Error(`${observed.error}${observed.next ? ` ${observed.next}` : ""}`);
        capture(observed);
        if (observed.admission || observed.initialAdvance)
          throw new Error("Terminal execute cursor unavailable to native admission.");
      } catch (error) {
        const disposition = cursorDisposition(retainedCursor, "blocked", String(error.message ?? error));
        return error.code === EXECUTE_CONTINUATION_INCOMPATIBLE ? { ...disposition, code: error.code } : disposition;
      }
      return cursorDisposition(retainedCursor, retainedCursor.loop.outcome === "complete" ? "complete" : "partial",
        "Retained terminal execute disposition; no replay or dispatch.");
    }
    for (const ref of retainedCursor.inFlight) inFlight.set(ref.key, clone(ref));
    try {
      if (config.initialAdvance) {
        const observation = await host(config.inspections[0]);
        checkAdmissionBinding(observation);
        if (observation.error || !same(observation.initialAdvance, config.initialAdvance) ||
            !matchesCursorRequest(retainedCursor))
          throw new Error(observation.error || "Initial advance preliminary/native replay integrity mismatch.");
        await beginStoreEpoch(retainedCursor, observation,
          retainedCursor.halt?.stage === "timeout" && reviewerTimeoutAction(retainedCursor.action)
            ? retainedCursor.action : undefined);
      } else invocation = await replayCursorAdmission(retainedCursor);
      if (invocation?.pendingSelectionDrain) {
        const pending = invocation.pendingSelectionDrain;
        await persistState(stateKey, pending);
        retainedCursor = pending;
        invocation = await replayCursorAdmission(pending);
      }
    }
    catch (error) {
      if (error.hostHalt && (!retainedCursor.halt ||
          retainedCursor.halt.stage === "timeout" && reviewerTimeoutAction(retainedCursor.action) &&
          matchesCursorRequest(retainedCursor))) {
        const held = { ...retainedCursor, hostHalt: hostHaltCursor(retainedCursor, error.hostHalt) };
        await persistState(stateKey, held);
        return hostHaltDisposition(held, hostHaltReport(held.action, held.hostHalt));
      }
      if (error.viewOverflowHalt && !retainedCursor.halt) {
        const halt = error.viewOverflowHalt, { ref } = halt;
        const held = { ...retainedCursor, halt: { stage: halt.code, digest: canonicalDigest(halt) },
          inFlight: ref ? [...retainedCursor.inFlight.filter(item => item.key !== ref.key), { ...ref, role: "loop-io" }] : retainedCursor.inFlight };
        await persistState(stateKey, held);
        return { ...cursorDisposition(held, halt.status, halt.reason), loopReport: { halt } };
      }
      if (pitakoAgentFamily(error.nativeReference?.agent) === "loop-io" && error.nativeReference.runId &&
          retainedCursor.action.kind === "pending" && ["close", "drain", "gate"].includes(retainedCursor.action.op) &&
          error.nativeReference.key.replace(/\.r\d+$/, "") === retainedCursor.action.opKey &&
          ["stopped", "interrupted", "native permission denial"].includes(error.nativeBarrier) && !retainedCursor.halt) {
        const halt = loopIOHalt(error.nativeReference, error.nativeBarrier);
        const held = { ...retainedCursor, halt: { stage: halt.code, digest: canonicalDigest(halt) },
          inFlight: [...retainedCursor.inFlight.filter(item => item.key.replace(/\.r\d+$/, "") !== retainedCursor.action.opKey),
            { key: halt.ref.key, runId: halt.ref.runId, role: "loop-io" }] };
        await persistState(stateKey, held);
        return { ...cursorDisposition(held, halt.status, halt.reason), loopReport: { halt } };
      }
      if (error.settlementHalt && !retainedCursor.halt) {
        const halt = settledNativeHalt(error.settlementHalt), { key, runId, agent } = halt.ref;
        const held = { ...retainedCursor, halt: { stage: "native-settlement", digest: canonicalDigest(halt) },
          inFlight: [...retainedCursor.inFlight.filter(item => item.key !== key),
            { key, runId, role: pitakoAgentFamily(agent) }] };
        await persistState(stateKey, held);
        return { ...cursorDisposition(held, halt.status, halt.reason), loopReport: { halt } };
      }
      if (!await recoverStoreEpoch(error, retainedCursor)) {
        const disposition = cursorDisposition(retainedCursor,
          error.code === "superseded" ? "partial" :
            ["stopped", "interrupted"].includes(error.nativeBarrier) ||
              error.nativeBarrier && /\.task-(reviewer|synthesis)$/.test(error.nativeReference?.key ?? "") ? "cancelled" : "blocked",
          String(error.message ?? error));
        return error.code === EXECUTE_CONTINUATION_INCOMPATIBLE ? { ...disposition, code: error.code } : disposition;
      }
    }
  }
  if (invocation?.retainedReviewHalt) {
    const halt = invocation.retainedReviewHalt;
    return { ...cursorDisposition(retainedCursor, halt.status, halt.reason), loopReport: { halt } };
  }
  if (invocation?.retainedGateHalt || invocation?.retainedAnalysisHalt)
    return retainedTimeoutDisposition(retainedCursor, invocation.retainedGateHalt ?? invocation.retainedAnalysisHalt);
  if (invocation?.retainedPlanImpediment) {
    const { reason, halt, ref } = invocation.retainedPlanImpediment;
    return { ...cursorDisposition(retainedCursor, "blocked", reason),
      action: { actor: "evidence owner", operation: "resolve the concrete retained impediment; no replacement dispatch",
        reason, references: [ref], started: false },
      loopReport: { halt, pending: [{ reason, references: [ref] }] } };
  }
  if (invocation?.retainedSemanticHalt) {
    const halt = invocation.retainedSemanticHalt;
    const disposition = cursorDisposition(retainedCursor, halt.status, halt.reason);
    const loopReport = { type: "execution-loop", invocation: retainedCursor.invocation,
      loop: retainedCursor.loop.number, phase: retainedCursor.loop.phase, maxLoops: retainedCursor.budget.maxCycles,
      status: halt.status, reason: halt.reason, halt, actionRequired: halt.reason,
      next: "resolve observed impediment", pending: [{ reason: halt.reason, references: [invocation.ref] }] };
    if (typeof emit === "function") emit(loopReport);
    return { ...disposition, loopReport };
  }
  if (invocation?.retainedDispatchHalt || invocation?.retainedActivityHalt) {
    const halt = invocation.retainedDispatchHalt ?? invocation.retainedActivityHalt;
    return { ...cursorDisposition(retainedCursor, halt.status, halt.reason),
      ...(halt.code === "spawn-budget" ? { action: { actor: "human", reason: halt.reason,
        operation: "raise config.maxSubagentSpawnsPerRun or reduce the step's spawn demand, then start a new invocation",
        references: [], started: false } } : {}),
      loopReport: { halt, pending: [{ references: [halt.ref ?? invocation.ref].filter(Boolean) }] } };
  }
  if (invocation?.replayedDrain) return await finishFinalDrain(retainedCursor, invocation.replayedDrain);
  if (invocation?.renewedGateHalt) {
    const { cursor, halt } = invocation.renewedGateHalt;
    await persistState(stateKey, cursor);
    return retainedTimeoutDisposition(cursor, halt);
  }
  if (invocation && retainedCursor) invocation.lastBudgetProgress = retainedCursor.budget.lastProgress;
  // Incompatible retained state fails before any resume or dispatch.
  if (!Number.isSafeInteger(config.stateVersion)) return finish("blocked", "Missing resolved execute state contract version.");
  if (invocation && invocation.version !== config.stateVersion)
    return { ...finish("blocked", `${EXECUTE_CONTINUATION_INCOMPATIBLE}: Retained execution created by an incompatible Pitako contract v${invocation.version}. No migration or replay is supported; retained unchanged.`, true),
      code: EXECUTE_CONTINUATION_INCOMPATIBLE };
  activePlan = invocation?.activePlan;
  loop = invocation?.loop;
  if (invocation?.transitionReplay) {
    const replay = invocation.transitionReplay;
    const nextLoop = loop;
    loop = { number: replay.number, phase: "implementation", cursor: 0, archived: true,
      outcome: "gaps", results: [], recoveries: [], usage: [],
      ...(replay.drained ? { cancellation: { stage: "receipt", receipt: replay.drained } } : {}),
      nextAdvance: { stage: "receipt", receipt: replay.receipt } };
    invocation.loop = loop;
    invocation.consumedLoops--;
    invocation.tasks = replay.tasks;
    invocation.requestObservation = replay.requestObservation + 1;
    invocation.lastRequestReceipt = replay.receipt;
    dispatchedAction = { kind: "pending", op: "advance", opKey: `${key}.l${loop.number}.nextAdvance` };
    await admitRequests(replay.requests);
    if (replay.drained) invocation.receiptReference = receiptReference(replay.drainedReference);
    if (!invocation.currentView) delete nextLoop.advance;
    invocation.tasks = {};
    invocation.consumedLoops++;
    loop = nextLoop;
    invocation.loop = loop;
    dispatchedAction = undefined;
    delete invocation.transitionReplay;
  }
  if (invocation?.closedDrained) {
    for (const body of invocation.closedDrained) compactSealedAttempts(body);
    delete invocation.closedDrained;
  }
  if (invocation?.foldedContinuation) {
    restoreCloseContinuation(invocation.foldedContinuation);
    delete invocation.foldedContinuation;
  }
  // Validate the stored request before even read-only reconstruction. Snapshot
  // equality is checked against the inspector below, never repaired from input.
  if (invocation?.association) {
    if (!same(invocation.amendments ?? [], config.amendments ?? []))
      return finish("blocked", "Immutable admission amendments changed; preserve retained path, SHA-256 and provenance, no recovery merge or replacement.");
    if (!/^[a-f0-9]{64}$/.test(invocation.admissionBinding ?? ""))
      return finish("blocked", "Retained execution predates bound native admission; no migration or replay is supported. Preserve its evidence. Inspect its actual native terminal/barrier state; a revised assignment and new admission require actual human authorization, not resuming a terminal root.");
    const expected = invocation.association;
    if (expected.missionId !== config.missionId || expected.missionPath !== config.missionPath ||
        expected.invocation !== config.invocation || expected.root !== config.root ||
        !same(expected.sourceRefs ?? [], config.sourceRefs ?? []))
      return finish("blocked", "Immutable mission/invocation/worktree request changed; retained unchanged.");
  }
  if (dispatchedAction?.kind === "pending" && loop?.attempt?.received) await save();
  if (retainedCursor?.action.kind === "launched" && retainedCursor.action.role === "reviewer" &&
      retainedCursor.action.runId === null &&
      retainedCursor.budget.rejectedKeys.includes(canonicalDigest(retainedCursor.action.key)))
    retainedAnalysisDeadline = { key: retainedCursor.action.key, ms: retainedCursor.timeouts.reviewerMs };
  if (invocation?.association) await updateTimeouts();
  let admissionObservation = replayAdmissionObservation;
  let consumedCheckpointObservation = false;
  if (loop?.halt?.code === "timeout") {
    if (["gate-transport", "final-acceptance"].includes(loop.halt.class)
      ? effectiveTimeouts().gateFloorMs > 0 : (loop.halt.class === "worker"
        ? effectiveTimeouts().workerMs : effectiveTimeouts().reviewerMs) > loop.halt.launchedMs) {
      // Verify resolve's retained originals before retirement changes their projection.
      admissionObservation = replayAdmissionObservation ?? await host(config.inspections[0]);
      if (text(admissionObservation.error))
        throw new Error([admissionObservation.error, admissionObservation.next].filter(Boolean).join(" "));
      const captured = capture(admissionObservation);
      if (loop.halt.class === "worker") checkpointObservation = captured.metadata.checkpointObservation;
    }
    const workerRenewal = loop.halt.class === "worker";
    const renewal = await renewAnalysisTimeout(retainedCursor);
    if (renewal?.retainedReviewHalt) {
      const halt = renewal.retainedReviewHalt;
      return { ...cursorDisposition(retainedCursor, halt.status, halt.reason), loopReport: { halt } };
    }
    await renewGateTimeout();
    await renewWorkerTimeout();
    if (loop.halt?.code === "timeout") return finish(loop.halt.status, loop.halt.reason);
    if (workerRenewal) consumedCheckpointObservation = true;
  }
  if (invocation?.lastBudgetProgress && loop?.halt) return finish(loop.halt.status, loop.halt.reason, true);
  if (invocation?.sealPending && !loop?.halt) await archiveSeal();
  const recoveredReviewCheckout = invocation?.reviewReplayCheckout;
  const current = recoveredReviewCheckout ? { checkout: recoveredReviewCheckout } :
    admissionObservation ?? await host(config.inspections[0]);
  if (text(current.error)) throw new Error([current.error, current.next].filter(Boolean).join(" "));
  const captured = recoveredReviewCheckout ? { metadata: { root: invocation.association.root,
    commonDir: invocation.association.commonDir,
    selected: { source: invocation.association.source, digest: invocation.association.digest } } } :
    capture(current, invocation?.replayedFinalGate || invocation?.replayedEarlyDemand
      ? { ...config, preliminaryStoreFailure: undefined } : undefined);
  let metadata = captured.metadata;
  if (!invocation && current.initialAdvance) {
    const { restored, receipt } = await replayInitialAdvance(current.initialAdvance, recoveredEpochCursor);
    invocation = restored;
    loop = invocation.loop;
    if (recoveredEpochCursor) {
      // The projection already includes the committed observation number.
      invocation.lastRequestReceipt = invocation.receiptReference;
      await admitRequests(groupedStep(receipt, "requests"));
    } else await save();
  }
  if (!invocation?.association) {
    const admitted = recoveredEpochCursor ? { maxCycles: recoveredEpochCursor.budget.maxCycles } : current.admission ?? {};
    if (text(admitted.error)) throw new Error(admitted.error);
    if (!Number.isSafeInteger(admitted.maxCycles) || admitted.maxCycles < 1)
      throw new Error("Invalid pitako.execute.maxCycles admission receipt.");
    if (admitted.revivalContextPeak !== undefined &&
        (!Number.isSafeInteger(admitted.revivalContextPeak) || admitted.revivalContextPeak < 1))
      throw new Error("Invalid pitako.execute.revivalContextPeak admission receipt.");
    for (const name of ["taskReviewer", "taskSynthesis"])
      if (admitted[name] !== undefined && (typeof admitted[name] !== "string" || admitted[name].trim() !== admitted[name] ||
          !/^[^/\s:*?,]+\/[^\s*?,]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(admitted[name])))
        throw new Error(`Invalid pitako.execute.${name} admission receipt.`);
    const reviewModels = admitted.reviewModels === undefined ? {
      r1: { key: "pitako.review.r1", model: "anthropic/claude-opus-5-5:high" },
      r2: { key: "pitako.review.r2", model: "openai-codex/gpt-6.1-sol:xhigh" },
      synthesis: { key: "pitako.review.synthesis", model: "anthropic/claude-opus-5-5:high" },
    } : admitted.reviewModels;
    for (const slot of ["r1", "r2", "synthesis"])
      if (reviewModels?.[slot]?.key !== `pitako.review.${slot}` ||
          typeof reviewModels[slot].model !== "string" ||
          reviewModels[slot].model.trim() !== reviewModels[slot].model ||
          !/^[^/\s:*?,]+\/[^\s*?,]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(reviewModels[slot].model))
        throw new Error(`Invalid pitako.review.${slot} admission receipt.`);
    invocation = {
      version: config.stateVersion, association: { missionId: config.missionId, missionPath: config.missionPath,
        invocation: config.invocation, root: metadata.root, commonDir: metadata.commonDir,
        source: metadata.selected.source, digest: metadata.selected.digest,
        maxCycles: admitted.maxCycles, sourceRefs: config.sourceRefs ?? [] },
      revivalContextPeak: admitted.revivalContextPeak ?? 120000,
      taskReviewer: admitted.taskReviewer ?? "openai-codex/gpt-6.1-sol:xhigh",
      taskSynthesis: admitted.taskSynthesis ?? "anthropic/claude-opus-5-5:high",
      reviewModels: clone(reviewModels),
      admissionBinding: current.binding, amendments: clone(config.amendments ?? []), startedAt: Date.now(), consumedLoops: 0, ledger: { count: 0, head: null }, sealPending: null,
      recoverySeq: 0, lastRecoveryRef: null, lastConfirmed: null, usageTotals: { tokens: 0, known: 0, unknown: 0 },
      tasks: {}, taskFrame: null, loop: null,
      planRejections: [], closeReferences: [], loopSummaries: [], activePlan: null,
    };
    if (recoveredEpochCursor) {
      const cursor = recoveredEpochCursor;
      invocation.association.maxCycles = cursor.budget.maxCycles;
      if (canonicalDigest(invocation.association) !== cursor.associationDigest ||
          invocation.admissionBinding !== cursor.admissionBinding)
        throw new Error("Store epoch recovery immutable admission integrity mismatch.");
      invocation.epoch = cursor.epoch + 1;
      invocation.consumedLoops = cursor.budget.consumedLoops;
      invocation.budgetRejectedKeys = clone(cursor.budget.rejectedKeys);
      invocation.timeouts = { values: clone(cursor.timeouts), since: null };
      invocation.taskReviewer = cursor.models.taskReviewer;
      invocation.taskSynthesis = cursor.models.taskSynthesis;
      invocation.reviewModels = Object.fromEntries(["r1", "r2", "synthesis"].map(slot =>
        [slot, { key: `pitako.review.${slot}`, model: cursor.models[slot] }]));
    }
    if (metadata.root !== config.root) throw new Error("Designated worktree mismatch.");
    await updateTimeouts();
    await save();
  } else {
    replay = true;
    if ((!Number.isSafeInteger(invocation.association?.maxCycles) ||
        invocation.association.maxCycles < 1 || !same(invocation.association.sourceRefs, config.sourceRefs ?? [])))
      throw new Error("Incompatible immutable maxCycles/sourceRefs association; retained unchanged.");
    if (metadata.selected.digest !== invocation.association.digest)
      throw new Error(`Immutable full snapshot content changed: ${metadata.selected.source}; retained unchanged. Restore exact bytes from a reliable original and deliver desired changes as an explicit human addendum; without reliable originals remain blocked. A revised admission needs actual human authorization.`);
    const observed = metadata.selected;
    const expected = invocation.association;
    if (expected.missionId !== config.missionId || expected.missionPath !== config.missionPath ||
        expected.invocation !== config.invocation || expected.root !== config.root ||
        observed.digest !== expected.digest ||
        metadata.root !== expected.root || metadata.commonDir !== expected.commonDir || observed.source !== expected.source)
      return finish("blocked", `Immutable mission/invocation/snapshot/worktree association changed at ${metadata.selected.source}; expected ${JSON.stringify(expected)}, observed binding ${current.binding}, source ${observed.source}, digest ${observed.digest}, root ${metadata.root}, commonDir ${metadata.commonDir}. Preserve the admitted snapshot; restore exact bytes from a reliable original and deliver desired changes as an explicit human addendum. If originals are unavailable remain blocked; a revised admission requires actual human authorization. Native barriers require supported native reconciliation.`);
    activePlan = invocation.activePlan;
    invocation.activePlan = null;
  }
  admissionValidated = true;
  inspectedAnalyses = metadata.retainedAnalyses ?? [];
  checkpointObservation = consumedCheckpointObservation ? undefined : metadata.checkpointObservation;
  currentCandidate = candidate(current.checkout);
  loop = invocation.loop;
  // Older readers promoted a saved non-blocked pause into a human impediment.
  // Reconcile only that exact admitted result, never a native or worker barrier.
  if (confirmedPausePending() && loop.attempt.result.status !== "blocked" &&
      loop.halt?.code === "semantic-block" && same(loop.halt.ref, loop.attempt.result.ref) &&
      loop.halt.reason === loop.attempt.result.diagnosis) {
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  // Recover the old result-committed/outcome-not-committed cut before plan recovery.
  if (loop?.attempt?.stage === "result" && loop.attempt.result?.status === "blocked" &&
      (!loop.halt || loop.halt.code === "semantic-block"))
    retainWorkerBlock(loop.attempt.result);
  if (["capacity", "native-dispatch", "semantic-block", "checkpoint-integrity", "task-review-model",
      "needs-decision", "repeat-acceptance"].includes(loop?.halt?.code))
    return finish(loop.halt.status, loop.halt.reason, true);
  // A completed verdict is reusable only for the same closing candidate.
  if (loop?.outcome === "complete" && same(loop.closing?.candidate, currentCandidate))
    return finish("complete", "Whole-spec fulfillment, mandatory checks and review remain bound to this candidate. No more loops required.");
  if (loop?.outcome === "complete") {
    loop.outcome = "gaps";
    loop.invalidated = "candidate-changed";
    await save();
  }
  if (loop?.halt?.code === "native-barrier" &&
      ["running", "queued", "pending"].includes(loop.halt.cause) && loop.attempt && !loop.attempt.result) {
    // Re-observe retained activity, not an automatic effect. Historical activity
    // is not a recorded user Stop or proof that its successor is still pending.
    loop.attempt.interruption ??= clone(loop.halt);
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  if (loop?.halt?.code === "native-barrier")
    return finish(loop.halt.status, loop.halt.reason, true);
  if (loop?.outcome === "blocked" || loop?.outcome === "cancelled")
    return finish(loop.outcome, "Retained impediment; continue only in a new invocation.", true);
  // A technical halt raised before any director plan or writer names no retained
  // producer: replay re-runs the same retained pre-director intention, which
  // re-halts if its cause persists. Discharge it durably before that dispatch so
  // no later writer launches under a stale halt the checkpoint hook refuses.
  if (loop?.halt?.code === "recovery" && loop.phase === "director" && !loop.plan && !loop.attempt && !loop.archived) {
    delete loop.halt;
    await save();
  }
  while (true) {
    if (loop?.outcome === "gaps" && !loop.archived) await archiveGaps();
    // Reconcile transition requests even when their prepare was already saved.
    if (loop?.outcome && (invocation.intentions?.length || invocation.pendingCancellations?.length ||
        loop.cancellationInput || loop.nextAdvance && !invocation.preparedNext) &&
        invocation.consumedLoops < maxCycles()) {
      await advanceLoop("nextAdvance", loop.number + 1);
      if (loop.halt) return finish(loop.halt.status, loop.halt.reason);
    }
    if (!loop || loop.outcome) {
      if (invocation.consumedLoops >= maxCycles()) return await finish("partial", `${maxCycles()} authorized loops consumed; remaining work requires new human authorization.`);

      activePlan = null;
      const prepared = invocation.currentView && (invocation.preparedNext ?? loop?.prepare);
      const number = invocation.consumedLoops + 1;
      loop = { ...(prepared ? { prepare: clone(prepared) } : {}), number,
        startedAt: committedLoopOpen(number) ?? Date.now(), phase: "director",
        cursor: 0, manifest: null, plan: null, attempt: null, results: [], recoveries: [], usage: [] };
      invocation.loop = loop;
      delete invocation.preparedNext;
      invocation.consumedLoops++;
      invocation.tasks = {};
      invocation.taskFrame = null;
      // Slot is consumed durably BEFORE calling a fresh read-only director.
      await save();
    }
    if (loop.phase === "director") {
      if (!invocation.currentView) {
        await advanceLoop();
      }
      const directorKey = `${key}.l${loop.number}.director${loop.directorRetry ? ".d1" : ""}`;
      const replayedSelection = loop.replayedSelection;
      const replayedFailure = loop.replayedSelectionFailure;
      if (!replayedSelection && !replayedFailure && (!loop.plan || budgetRejected(directorKey))) {
        const observation = loop.directorRetry ? null : await observeDemands();
        loop.plan = { stage: "intention", ref: { key: directorKey } };
        await save();
        const result = await collect(directorKey, "pitako.execution-director",
          { label: "Plan execution work", phase: "planning" }, `${fullContext()}
EXCLUDED SCOPE (not human intent; do not plan this work again, including under new IDs): ${JSON.stringify(cancelledScope())}
Report this work as unfulfilled: cancelled by main-session request, with its origin.
INDEPENDENT DEMAND OBSERVATION (advisory): ${JSON.stringify(observation)}
PREVIOUS OBSERVATIONS AND EXACT ORIGINAL SOURCES: ${JSON.stringify(demandHistory())}
Read pertinent full originals alongside observations; agent reports are not human authority.
An old expansion is not legitimized by repetition; resolved historical work is not automatically pending.
Formulate your sole plan from authorized sources, retaining necessary work without automatically
inheriting questioned expansions. No ceremonial response to each observation is required.
READ-ONLY BACKLOG SELECTION ONLY. Do not delegate, implement, run checks/review or supervise execution.
Read the complete backlog at ${invocation.backlogPath} (if absent, derive it from the full spec).
CURRENT BACKLOG DIGEST: ${JSON.stringify(invocation.backlogDigest)}
CURRENT BOARD VIEW: ${canonicalJSON(invocation.currentView)}
${loop.directorRetry ? `PREVIOUS SELECTION REJECTED: ${loop.directorRetry.diagnostic}\nCorrect the validation error and publish one replacement selection.` : ""}
Return exactly {select, changes, reason}: select the single most important pending task whose dependencies are done.
Changes are keyed add | split | obsolete | update operations, each with a reason; first creation uses only add.
update patches only goal, expectedResult, specRefs, dependsOn, gates, metric, remaining and title; never change id, origin or status (use obsolete, split or add).
Three consecutive non-improving attempts stall a task loop; this threshold is unchanged.
After a stall, re-selection requires a changed definition: the same output must include an update with a reason
that changes the definition digest over {goal, expectedResult, gates, metric, dependsOn}; remaining does not count.
Alternatively, split with a reason obsoletes the stalled parent and creates new child IDs with stalls = 0, which may be selected.
loop-io apply rejects unchanged re-selection as gaps: "stalled task re-selected without a changed definition".
Each stall increments progress.stalls and records the definition digest and diagnosis in history; todo rows show stalls N/2.
The second stall of the same task ID halts needs-decision for the human with task ID, metric series and both stall diagnoses.
The human edits the backlog or delivers an amendment, then posts the ruling as Board HUMAN and starts a new invocation on the same worktree and backlog.
New and updated tasks require a non-empty title of at most 80 characters; legacy titles fall back to the ID for display. New tasks follow the supplied backlog task schema. Gates are focused commands, not the complete suite.
Tasks needing multiple attempts declare a numeric metric {command, unit, target}.
Never reuse IDs or reopen done/obsolete tasks. Reconcile changed spec/amendment authority with reasons.
Select null only when there is no pending or blocked task; the workflow then enters the final phase.
Acceptances belong to the final phase, never an ordered verification task.
Backlog authority: ${JSON.stringify(backlogAuthority())}
${Array.isArray(config.originalProblem?.criteria) ? `ORIGINAL PROBLEM: criteria ${config.originalProblem.criteria.map(n => `#${n}`).join(", ")}.
Optionally designate gates and acceptance commands with verifies: [positive criterion numbers]. Only current workflow gate receipts update the advisory notice.` : ""}
An optional acceptance: [{id, command, cwd, verifies?, exception?: {humanRef, reason}}] field carries the complete procedure from the spec, GATES.md and AGENTS.md.
It is REQUIRED and non-empty to initialize a backlog. Later replacement requires your reason, retained in acceptanceHistory.
An exception is allowed only when a current HUMAN in the view exempts that command; humanRef is that post's id. At least one entry stays blocking.
Do not run the acceptance commands; the final phase runs them.
Publish one selection with the native output binding then END. Native permissions and Stop apply.`,
          planSchema);
        loop.plan = { ...projection(directorKey, result), stage: "published" };
        if (barrier(result)) throw nativeBarrier(barrier(result), loop.plan.ref, result);
        // Publication and admission are separate durable cuts.
        await save();
        if (!result?.ok && !text(result?.runId))
          throw new Error("Director failed without an authoritative settled producer reference.");
        activePlan = result?.structuredOutput;
        if (!activePlan && !(await recoverPlan()))
          throw new Error("No authoritative complete new backlog selection survives.");
        planAuthority(activePlan, result?.structuredOutput ? result : undefined);
        if (!result?.structuredOutput) planAuthority(activePlan, result);
      } else if (!replayedSelection && !replayedFailure && (!loop.task || replay)) {
        replay = false;
        if (!await recoverPlan()) {
          if (loop.plan.ok === false) throw new Error("No authoritative complete new backlog selection survives.");
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          loopReport("gaps", "Original complete backlog selection lost; no task reconstructed from IDs.");
          continue;
        }
      }
      if (!replayedSelection && !replayedFailure) {
        planAuthority(activePlan);
        validatePlan(activePlan);
      }
      let applied;
      let rejectionArchive;
      let transport;
      try {
        if (replayedFailure) {
          delete loop.replayedSelectionFailure;
          throw Object.assign(new Error(replayedFailure.reason), {
            selectionRejected: true, replayRejected: replayedFailure.replayRejected,
          });
        }
        if (loop.selection?.stage === "receipt") assertSelection();
        if (!replayedSelection && text(activePlan.select))
          loop.initialCheckpoint ??= checkpointIntent(activePlan.select, 1, `${key}.l${loop.number}.t1.a1`);
        if (!replayedSelection) await save();
        // On the last budgeted loop, selection may be the last writer before the drain.
        if (!replayedSelection && invocation.consumedLoops >= maxCycles()) {
          const generation = invocation.finishDrain?.admitted ? (invocation.finishDrain.generation ?? 0) + 1 : 0;
          const archive = loopArchive();
          rejectionArchive = { ...archive, key: `${key}.l${loop.number}.finishDrain${generation ? `.v${generation}` : ""}`,
            ...(archive.expected.count === 0 ? { spec: { content: config.preliminary.content,
              digest: invocation.association.digest } } : {}),
            ...(loop.directorRetry ? { previous: archiveProjection(loop.directorRetry) } : {}) };
        }
        transport = replayedSelection ?? await groupedIO(`selectionIO${loop.directorRetry ? ".d1" : ""}`, { operation: "selection",
          ...(committedLoopOpen(loop.number) === undefined ? { loopStartedAt: loop.startedAt } : {}),
          plan: clone(loop.plan), usage: clone(loop.usage),
          ...(loop.recoveries.length ? { recoveries: clone(loop.recoveries) } : {}),
          ...(rejectionArchive ? { rejectionArchive } : {}),
          apply: { root: config.root, specId: config.id, expectedDigest: invocation.backlogDigest,
            key: `${key}.l${loop.number}.selection${loop.directorRetry ? ".d1" : ""}`,
            invocation: config.invocation, loop: loop.number, authority: backlogAuthority(), director: activePlan },
          ...(loop.initialCheckpoint ? { baseline: loop.initialCheckpoint } : {}) });
        applied = groupedStep(transport, "apply");
        const { selected, completedTasks, ...receipt } = applied;
        loop.task = selected; loop.taskBacklogDigest = applied.digest;
        loop.selection = { stage: "receipt", receipt: { ...receipt, selected: selected?.id ?? null,
          ...(!selected ? { completedTasks } : {}), groupedReference: receiptReference(transport) } };
        if (!replayedSelection) await save();
        if (loop.initialCheckpoint) loop.selectionBaseline = groupedStep(transport, "baseline");
        loop.selectionRequests = { reference: receiptReference(transport), page: groupedStep(transport, "requests") };
      } catch (error) {
        const diagnostic = String(error?.message ?? error);
        if (!error.selectionRejected || error.backlogConflict) throw error;
        inFlight.delete(loop.plan.ref.key);
        if (!loop.directorRetry && !error.replayRejected && !loop.plan.ref.key.endsWith(".d1")) {
          loop.directorRetry = { diagnostic: diagnostic.slice(0, 2000), rejectedRef: clone(loop.plan.ref) };
          loop.plan = null; delete loop.selection; delete loop.initialCheckpoint; activePlan = null;
          await save(); continue;
        }
        loop.plan.stage = "rejected"; loop.plan.rejection = { diagnostic, ref: clone(loop.plan.ref),
          ...(loop.directorRetry ? { previous: clone(loop.directorRetry) } : {}) };
        loop.outcome = "gaps"; loop.endedAt = Date.now(); activePlan = null; invocation.currentView = null;
        if (rejectionArchive) {
          const saved = error.rejectedDrain;
          if (saved?.storeId !== invocation.storeId || saved.head?.seq <= invocation.head.seq)
            throw new Error("Final selection rejection lacks its committed drain.");
          const input = committedIntentReference({ seq: saved.head?.seq, digest: saved.head?.hash }, saved.head);
          invocation.head = clone(saved.head);
          const opKey = rejectionArchive.key;
          invocation.finishDrain = { key: opKey, retry: 0, stage: "intention" };
          dispatchedAction = { kind: "pending", op: "drain", opKey, input };
          const receipt = await loopIO("finishDrain", finalDrainInput(executeCursor()), invocation);
          const cursor = executeCursor();
          return await finishFinalDrain(cursor, admitFinalDrain(cursor, receipt, null));
        }
        await save(); loopReport("gaps", diagnostic); continue;
      }
      inFlight.delete(loop.plan.ref.key);
      invocation.backlogDigest = applied.digest;
      invocation.excludedScope = Object.fromEntries((applied.cancelledScope ?? []).map(task => [task.id, task]));
      invocation.currentView = applied.view; invocation.boardTopicId = applied.view.topicId;
      loop.kind = applied.selected ? "task" : "final";
      loop.task = applied.selected;
      if (loop.kind === "final") {
        // One retained copy: the selection receipt's copy only bridges this admission.
        loop.acceptance = applied.acceptance; loop.acceptanceHistory = applied.acceptanceHistory;
        loop.completedTasks = applied.completedTasks;
        delete loop.selection.receipt.acceptance;
        delete loop.selection.receipt.acceptanceHistory;
        delete loop.selection.receipt.completedTasks;
      }
      loop.metricSeries = clone(applied.selected?.progress ?? { nonImproving: 0, last5: [] });
      loop.manifest = applied.selected ? [applied.selected.id] : [];
      invocation.tasks = Object.fromEntries(loop.manifest.map(id => [id, { admitted: [], completed: null, last: null }]));
      loop.plan.association = association(loop.number); loop.plan.stage = "admitted";
      if (loop.initialCheckpoint) loop.initialCheckpoint = admitBaseline(loop.initialCheckpoint, loop.selectionBaseline,
        transport.head);
      delete loop.selectionBaseline;
      delete loop.replayedSelection;
      loop.phase = "implementation";
      // The committed selection already carries the final-loop director binding.
      if (replayedSelection && loop.kind === "final") replay = false;
      // Full views remain replayable until this selection-admission save.
      for (const slot of ["prepare", "selection"]) {
        const receipt = loop[slot]?.receipt;
        if (receipt?.view) receipt.view = { topicId: receipt.view.topicId,
          viewDigest: receipt.viewDigest, viewBytes: receipt.viewBytes };
      }
      activePlan = null;
      if (replayedSelection?.selectionCancellation) {
        const saved = replayedSelection.selectionCancellation;
        invocation.requestObservation = saved.number;
        invocation.backlogDigest = saved.backlogDigest;
        invocation.receiptReference = receiptReference(saved.receipt);
        invocation.excludedScope = Object.fromEntries(saved.cancelledScope.map(task => [task.id, task]));
        invocation.tasks[loop.task.id].cancel = clone(invocation.excludedScope[loop.task.id].cancel);
        await save();
      } else {
        await save();
        await observeGroupedRequests(loop.selectionRequests.reference, false, loop.selectionRequests.page);
      }
      delete loop.selectionRequests;
      for (const slot of ["selectionIO", "selectionIO.d1"]) if (loop[slot]?.stage === "receipt") {
        loop[slot].receipt = receiptReference(loop[slot].receipt); delete loop[slot].input;
      }
      await save();
    }
    if (loop.phase === "implementation") {
      // An unsaved halt still has its exact native writer receipt. Observe that
      // barrier before dispatching even an optional read-only plan inspector.
      let attemptObservation;
      if (replay && loop.attempt && loop.attempt.stage !== "result" && !budgetRejected(loop.attempt.key)) {
        await observePendingSealer();
        const ref = loop.attempt.launch ?? { key: loop.attempt.key };
        attemptObservation = await observeStatus(ref.runId ?? ref.key, !!loop.attempt.checkpoint);
        assertFallbackProducer(attemptObservation, ref);
      }
      // On recovery compare original full values/binding before another edit.
      if (loop.kind === "task" && !loop.task || replay && loop.finalAttempt?.gate?.stage !== "receipt") {
        replay = false;
        if (!await recoverPlan()) {
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          loopReport("gaps", "Complete task definition unavailable."); continue;
        }
      }
      while (loop.cursor < loop.manifest.length) {
        const task = selectedTasks()[loop.cursor];
        if (invocation.sealPending) await archiveSeal();
        if (!invocation.taskFrame) invocation.taskFrame = { taskId: task.id, identities: [], evidence: [], operations: [], restorationKeys: [] };
        await persistCancellations();
        const cancelled = invocation.tasks[task.id]?.cancel;
        // A current attempt is allowed to settle. Only undispatched or settled work is skipped.
        if (cancelled && !invocation.tasks[task.id]?.completed && (!loop.attempt || ["result", "settled"].includes(loop.attempt.stage) ||
            loop.attempt.stage === "intention" && !loop.attempt.launch)) {
          loop.cursor++; loop.attempt = null; invocation.taskFrame = null; await save(); continue;
        }
        const prerequisites = prerequisiteResults(task);
        let value;
        if (loop.attempt?.stage === "result") {
          // Result is committed before cursor movement: do not repeat completed edits.
          const previous = loop.attempt.result;
          if (previous.status === "blocked") return finish("blocked", loop.halt.reason);
          if (previous.status === "complete") {
            await settleTask();
            loop.cursor++; loop.attempt = null; invocation.taskFrame = null; await save(); continue;
          }
          if (!previous.usefulContinuation) break;
          nextWorkerAttempt(task);
          await save();
        } else if (loop.attempt && !loop.attempt.undispatched && !loop.attempt.restore?.undispatched && !budgetRejected(loop.attempt.key)) {
          // Never call an unresolved writer key as if native reuse were read-only.
          await observePendingSealer();
          const ref = loop.attempt.launch ?? { key: loop.attempt.key };
          let observed = attemptObservation ?? await observeStatus(ref.runId ?? ref.key);
          attemptObservation = null;
          assertFallbackProducer(observed, ref);
          observed = receivedResult(observed, ref);
          const cause = barrier(observed, ref.runId ?? ref.key);
          if (pendingCheckpointUnit() && !(observed?.ok && observed.structuredOutput && text(observed.runId)))
            observed = await continueAttempt(observed, ref, task);
          else if (cause === "interrupted")
            observed = await continueAttempt(observed, ref, task);
          if (observed === null) continue; // durable same-task checkpoint fallback intention
          if (barrier(observed)) throw nativeBarrier(barrier(observed));
          if (observed?.runId && observed?.structuredOutput &&
              (!ref.runId || observed.runId === ref.runId)) {
            if (loop.attempt.restore) await observeMainRequests(0, [], true);
            await sealAndAdmit(observed, loop.attempt, task, undefined, ref.runId ?? ref.key);
          } else {
            throw new Error("Pending v6 worker has no complete result/checkpoint route; no inspector or replacement authorized.");
          }
          await save();
          if (invocation.sealPending) await archiveSeal();
          continue;
        } else if (!loop.attempt) {
          loop.attempt = { taskId: task.id, index: loop.cursor, number: 1,
            timeoutMs: effectiveTimeouts().workerMs,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a1`, stage: "intention", continuationRef: null };
          await save();
        }
        if (loop.attempt.restore && !loop.attempt.foldedBaseline || loop.attempt.resumeRejection) await observeMainRequests();
        if (invocation.tasks[task.id]?.cancel) {
          loop.cursor++; loop.attempt = null; invocation.taskFrame = null; await save(); continue;
        }
        // Essential intention before dispatch; only the writer's published
        // preimages turn this pointer into a recoverable checkpoint.
        if (!loop.attempt.checkpoint) {
          loop.attempt.baseline = candidate(currentCandidate);
          loop.attempt.checkpoint = checkpointIntent(task.id, loop.attempt.number, loop.attempt.key);
          await save();
        }
        const folded = loop.attempt.foldedBaseline ?? (loop.attempt.number === 1 ? loop.initialCheckpoint : null);
        const { checkpoint, ...attempt } = loop.attempt;
        const baseline = folded ? { candidate: folded.checkpoint.baseline } : await loopIO("baselineIO", { operation: "baseline", root: config.root,
          intent: clone(checkpoint),
          continuation: encodeContinuation({ attempt: clone(attempt), taskState: clone(invocation.tasks[task.id]),
            taskFrame: clone(invocation.taskFrame), results: clone(loop.results), recoveries: clone(loop.recoveries),
            usage: clone(loop.usage),
            metricSeries: clone(loop.metricSeries ?? task.progress), view: clone(invocation.currentView),
            requests: clone(invocation.lastRequestPage),
            receiptReference: clone(invocation.receiptReference ?? null),
            intentions: clone(invocation.intentions ?? []), lastConfirmed: clone(invocation.lastConfirmed ?? null) }) }, loop.attempt);
        const admitted = folded ?? admitBaseline(loop.attempt.checkpoint, { ...baseline, captured: true }, baseline.head);
        loop.attempt.checkpoint = clone(admitted.checkpoint);
        loop.attempt.intent = clone(admitted.intent);
        for (const [childKey] of inFlight)
          if (childKey !== loop.attempt.key && /\.a\d+(?:\.task-(?:reviewer|synthesis))?$/.test(childKey))
            inFlight.delete(childKey);
        delete loop.taskReviewCursor;
        if (loop.attempt.number === 1) delete loop.initialCheckpoint;
        loop.attempt.baseline = clone(baseline.candidate);
        loop.attempt.checkpoint.baseline = clone(baseline.candidate);
        currentCandidate = clone(baseline.candidate);
        if (loop.attempt.resume && !same(currentCandidate, loop.attempt.resumeAfter)) {
          loop.attempt.revival.decision = "fresh";
          loop.attempt.revival.code = "candidate-changed";
          delete loop.attempt.resume;
          delete loop.attempt.bindingKey;
        }
        await save();
        if (loop.attempt.restore) {
          const restoredFrom = await observeStatus(loop.attempt.restore.producer.runId ?? loop.attempt.restore.producer.key, true);
          assertFallbackProducer(restoredFrom, loop.attempt.restore.producer);
          if (loop.attempt.timeoutGeneration) {
            const cause = analysisBarrier(restoredFrom, loop.attempt.restore.producer.runId);
            if (cause) throw nativeBarrier(cause, loop.attempt.restore.producer);
          }

          // Persist before launch; replay observes this exact key, never replaces it.
          delete loop.attempt.restore.undispatched;
          await save();
        }
        // Hook identity must be durable while the worker is running, not only after it settles.
        loop.attempt.bindingKey ??= loop.attempt.key;
        const posts = invocation.currentView?.posts ?? [];
        const newPosts = posts.filter(post => !(loop.attempt.boardPostIds ?? []).includes(post.id));
        loop.attempt.boardPostIds = posts.map(post => post.id);
        delete loop.attempt.undispatched;
        loop.attempt.stage = "launched";
        await save();
        const descriptor = clone(loop.attempt);
        if (descriptor.restore) descriptor.restore.checkpoint = descriptor.restore.sourceKeys.map(sourceKey => {
          const source = frameIntent(sourceKey);
          if (!source) throw new Error("Missing authenticated restoration source intent.");
          return clone(source);
        });
        let result = await collect(descriptor.key, "pitako.worker",
          { label: task.title ?? task.id, phase: "implementation" }, descriptor.resume
          ? revivalDelta(descriptor, invocation.tasks[task.id]?.last, newPosts, loop.metricSeries ?? task.progress)
          : `${fullContext()}
EXECUTE SINGLE TASK. No delegation, next-task selection, private diary/progress file.
When your task has three or more steps, record them with todo before the first edit and keep their status current. Show only your own steps, not the execute plan. Todo is display, not evidence; the structured result stays authoritative. A cancelled or deleted step never drops required work or checks.
The workflow owns review and compliance; do not launch or infer another reviewer.
Preserve required checks and native permissions/Stop. Do not commit or publish unless task authority explicitly permits it.
COMPLETE SHARED CONTEXT:\n${JSON.stringify(sharedContext())}
DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):
${JSON.stringify(prerequisites)}
Read relevant full results and check current assumptions; do not automatically repeat all prerequisite gates.
COMPLETE SELECTED TASK:\n${canonicalJSON(task)}
TASK CONTINUATION (data):
${canonicalJSON({ metricSeries: loop.metricSeries ?? task.progress ?? null,
  handoff: workerKnowledge(invocation.tasks[task.id]?.last)?.handoff ?? "",
  board: invocation.currentView ?? null,
  gateFailures: invocation.tasks[task.id]?.last?.gateFailures ?? null,
   previousResult: descriptor.continuationRef?.path ?? descriptor.continuationRef?.outputReference ?? descriptor.continuationRef?.outputArtifactPath ?? null })}
TASK REVIEW REPAIR (blocking findings and synthesis original; read that original in full):
${canonicalJSON(taskReviewRepair() ?? null)}
No other agents of this execution run concurrently. resource_snapshot is enough for host load;
do not ask the supervisor about concurrency. Current DECISIONs are binding working rules:
no reconfirmation is needed and they cannot expand scope. Authority: spec, frozen amendments and current HUMAN rulings (most recent human source wins; cite it) > DECISION > FINDING > HANDOFF; code wins over any map.
${descriptor.restore ? `CHECKPOINT FALLBACK (same pending task, not a metadata repair):
${canonicalJSON(descriptor.restore)}
Validate the complete exact associated checkpoint manifest with the owned helper before effects.
Writer observation is best-effort, not a terminal certificate. Missing receipts remain unknown.
Your FIRST checkout effect MUST be the owned helper restore operation for restore.checkpoint
with restore.authority, including its confirmedPause or confirmedUnit when present. That exact admitted seal
is the saved WIP baseline, NOT the original pre-unit bytes. Never omit or replace it.
When restore.checkpoint is an ordered array, pass it intact: the helper
selects the newest existing manifest and falls back ONLY on absence, never corruption/conflict.
An interrupted restore dispatch may not have captured its own unit; older exact sources remain
necessary. Never invent a backup at its nominal attempt key. It retains partial bytes before
restoration. Never restore other paths,
completed tasks to pre-unit bytes, earlier WIP, Git or native mission state. A confirmedUnit
source is usable only when pending captures are absent: preserve its sealed POST-unit bytes
and pending position, never its manifest preimages or an unadmitted seal. If attribution/conflict fails, stop.
The root sealer reads the actual restore.json and restored.json; do not echo a restore receipt.
This is direct writer execution evidence, not an independent inspector attestation. A settled restore
receipt means do NOT restore again after later task edits. Then use the normal write tools with the NEW checkpoint intention below
for pending work. Complete only this task; the workflow runs the required gates after you settle.
` : ""}PRE-WRITE CHECKPOINT INTENTION (not a backup until published):
${canonicalJSON(descriptor.checkpoint)}
Write code with edit, write or apply_patch; use bash for commands, tests and builds.
The checkpoint extension captures first-touch preimages and journals each call before allowing it.
Newly discovered paths are captured in this same attempt. Journal failures block writes;
do not bypass the hooks or invent capture scripts, manifests, private state paths or receipts.
Native launch context binds this attempt to its durable intention/progress.
Owned restoration helper ONLY: ${config.checkpointHelper ?? "skills/execute/checkpoint.mjs"}.
Never restore a unit with an admitted complete result. Editing provider/profile files does not
reload this session; retained legacy attempts keep their original write contract.
After all owned journaled writes settle, return your decision-only structured result.
The root chooses the checkpoint kind and seals metadata; do not call unit/pause, construct
checkpointReceipt, restoreReceipt or candidate identity, or transcribe checkpoint references.
Status and remaining describe THIS task; inherited mission gaps outside its scope go in diagnosis.
Stop/refusal or abrupt disappearance never authorizes extra edits or a promised post-cut capture.
Restoration is checkpoint-first after best-effort pertinent writer observation. Missing or
inconclusive historical receipts do not require resume/inspector chains. Positive current
activity and native Stop/refusal/permission/capacity remain barriers; never fabricate settlement.
Restore only journal-attributable effects, retaining partial bytes first; never reset/clean Git
or roll back consumed slots/history. Returned position is for existing root state reconciliation,
not permission to overwrite native mission state or promote stale checks.
ORIGINAL COMPLETE PLAN REFERENCES (fallback, never previews): ${canonicalJSON(clone(loop.plan.ref))}
If the selected task is unavailable inline, read it from ${invocation.backlogPath}; verify its ID ${JSON.stringify(task.id)}
and admitted backlog digest ${invocation.backlogDigest} before effects. Never reconstruct a task from director previews.
No definition => report blocked, never reconstruct scopes. Continuation reads the exact preceding result
${canonicalJSON(descriptor.continuationRef)} and addresses only useful diagnosed pending work on THIS task.
Report {work, status, remaining, knowledge:{findings, handoff}, continuation?:{mode:"resume"|"fresh", reason}}.
The optional continuation opinion has a reason of at most 200 characters; missing means fresh. The workflow decides whether to resume. The workflow runs the metric and gates
 after you settle. Complete file-writing tasks with passing gates receive a read-only three-question
 task review before sealing; unit requires review admission. Rejection seals pause and allows one
 same-slot repair with blocking findings, then gates and re-review. A rejected or incomplete repair
 or failed repair gates leaves gaps; a spec-exclusion conflict goes to gaps without repair.
 Tasks with no journaled write, failed gates or incomplete results skip review and retain the
 existing close path. The root chooses and seals unit or pause; you do not. Do not report per-check evidence,
candidate identities or checkpoint receipts. Do not run the full suite; the workflow reserves it
for the final phase. A complete report means the task implementation is ready for focused gates.
HANDOFF (at most 2 KiB) describes current repository locations, seams and metric state, never
agent narrative or next steps. Put pending work in remaining.
A FINDING records only a fact that changes how this task or another task is done.
Status or scope notes and tool failures with no consequence for the code are not FINDINGs.
Return structured_output after all owned journaled writes settle.`,
          workerSchema, true, dispatch, descriptor.resume);
        if (descriptor.resume && rejectedResume(result)) {
          const rejection = { ref: nativeReference(descriptor.key, result), reason: excerpt(result.error ?? result.output) };
          // A refused child has no writes, but its authenticated baseline still belongs to the slot.
          retainFrameIntent(descriptor.checkpoint, "reviewIntents");
          loop.results.push({ ...projection(descriptor.key, result), taskId: task.id, attempt: descriptor.number,
            status: "rejected", revival: { ...descriptor.revival, decision: "fresh", code: "resume-rejected" },
            diagnosis: rejection.reason });
          loop.attempt = { taskId: task.id, index: loop.cursor, number: descriptor.number + 1,
            timeoutMs: effectiveTimeouts().workerMs,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${descriptor.number + 1}`,
            stage: "intention", undispatched: true, continuationRef: descriptor.continuationRef,
            revival: { ...descriptor.revival, decision: "fresh", code: "resume-rejected" }, resumeRejection: rejection };
          await save();
          continue;
        }
        const launch = nativeReference(descriptor.key, result);
        launch.launchedMs = descriptor.timeoutMs;
        if (nativeTimeout(result)) {
          if (result.key && ![descriptor.key, result.runId].includes(result.key) ||
              result.agent && result.agent !== "pitako.worker" ||
              result.results?.some(entry => entry.agent && entry.agent !== "pitako.worker"))
            throw new Error("Worker timeout producer identity conflicts with frozen attempt.");
          if (result.terminalOutcome) launch.terminalOutcome = clone(result.terminalOutcome);
          launch.results = result.results?.map(entry => Object.fromEntries(
            ["agent", "timedOut", "terminalOutcome", "exitCode", "state", "structuredOutputPath", "savedOutputPath"]
              .filter(field => entry[field] !== undefined).map(field => [field, entry[field]])));
        }
        loop.attempt.launch = launch;
        if (descriptor.restore && result?.ok === false && !result.runId && text(result.error) && !barrier(result)) {
          // No second restorer is authorized after a native failure without a
          // producer identity. Keep the bounded diagnostic at the exact action.
          const failure = nativeFailure(descriptor.key, result.error, result);
          throw Object.assign(new Error(failure.reason), { nativeFailure: failure,
            nativeDispatch: { key: descriptor.key, role: "worker" } });
        }
        if (descriptor.resume && !result?.ok && !result?.runId && !barrier(result)) {
          await save();
          throw new Error("Resume failed without a definitive no-child refusal; replacement is not authorized.");
        }
        retainReceived(result);
        // Missing modifying results use the same checkpoint route on first
        // receipt as on replay; an inspector is not a rollback prerequisite.
        if (barrier(result) === "interrupted" || (pendingCheckpointUnit() && !barrier(result) &&
            !(result?.ok && result.structuredOutput && text(result.runId)))) {
          loop.attempt.stage = "launched";
          await save();
          result = await continueAttempt(result, loop.attempt.launch, task);
          if (result === null) continue;
        }
        if (barrier(result)) {
          loop.attempt.stage = "launched";
          throw nativeBarrier(barrier(result), nativeReference(descriptor.key, result), result);
        }
        loop.attempt.stage = "launched";
        if (result?.ok && result.structuredOutput)
          recordWorkerClose(loop.attempt, result, task);
        await save();
        if (!result?.ok) await observeMainRequests();
        if (!result?.ok) {
          loop.attempt.stage = "settled";
          loop.results.push({ ...projection(descriptor.key, result), taskId: descriptor.taskId, attempt: descriptor.number,
            checkpoint: { key: descriptor.checkpoint.key, manifest: `.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json` } });
          await save();
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          break;
        }
        if (!result.structuredOutput)
          throw new Error("Pending v6 worker has no complete result/checkpoint route; no inspector or replacement authorized.");
        value = await sealAndAdmit(result, loop.attempt, task);
        if (value === null) continue; // never-closed effect: restoring worker intention is durable
        await save();
        if (invocation.sealPending) await archiveSeal();
        await persistCancellations();
        if (value.status === "blocked") {
          return finish("blocked", loop.halt.reason);
        }
      }
      if (loop.cursor < loop.manifest.length) {
        await settleTask();
        if (loop.halt?.code === "needs-decision") return finish(loop.halt.status, loop.halt.reason);
        invocation.currentView = null;
        loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
        const rejected = loop.attempt?.result?.rejection;
        loopReport("gaps", rejected ? `Worker report rejected: ${rejected} Next director repeats only the affected work.`
          : "Task has pending work without a useful diagnosed same-task continuation.");
        continue;
      }
      if (loop.kind === "task") {
        loop.outcome = "gaps"; loop.endedAt = Date.now();
        await save(); loopReport("gaps", "Selected backlog task settled; continue with the next budgeted selection.");
        continue;
      }
      if (!Array.isArray(loop.acceptance) || !loop.acceptance.length)
        throw new Error("Final phase requires non-empty acceptance commands from the backlog receipt.");
      const finalAttempt = loop.finalAttempt ??= { key: `${key}.l${loop.number}.acceptance`, number: 1 };
      const acceptanceTask = finalAttempt.gate?.task ?? { id: "final-acceptance",
        gates: effectiveGates(loop.acceptance), metric: null };
      const exec = acceptanceTask.gates.map(({ id, command, cwd, timeoutMs }) => ({ id, command, cwd, timeoutMs }));
      const previous = invocation.lastFinalAcceptance;
      const reuse = previous?.loop < loop.number && same(previous.exec, exec) ? previous : undefined;
      const receipt = await verifyAttempt(finalAttempt, acceptanceTask, { status: "complete", knowledge: {} }, reuse);
      if (!receipt.reused && !receipt.mutated && !acceptanceResults().blocking.some(gate => ["timeout", "error"].includes(gate.status))) {
        invocation.lastFinalGate = finalAttempt.gate.record;
        invocation.lastFinalAcceptance = { loop: loop.number, gateKey: finalAttempt.gate.producer,
          candidate: candidate(receipt.after), exec, results: clone(receipt.gates) };
      }
      await save();
      if (receipt.reused && !currentAcceptance()) {
        retainFinalAcceptanceHalt("repeat-acceptance", receipt,
          acceptanceResults().blocking.filter(gate => gate.status !== "pass" || gate.exit !== 0));
        await save(); return finish("blocked", loop.halt.reason);
      }
      recordOriginalProblem(acceptanceTask, receipt, finalAttempt);
      const environment = acceptanceResults().blocking.filter(gate => ["timeout", "error"].includes(gate.status));
      if (environment.length) {
        const failures = acceptanceResults().blocking.filter(gate => gate.status !== "pass" || gate.exit !== 0);
        if (!receipt.mutated && failures.every(gate => gate.status === "timeout")) {
          const launchedMs = Math.max(...failures.map(gate => acceptanceTask.gates.find(command => command.id === gate.id).timeoutMs));
          await haltGateTimeout(finalAttempt, "final-acceptance", launchedMs);
          return finish("partial", loop.halt.reason);
        }
        retainFinalAcceptanceHalt("environment", receipt, environment);
        await save(); return finish("blocked", loop.halt.reason);
      }
      if (!currentAcceptance()) {
        const failed = acceptanceResults().blocking.filter(gate => gate.status === "fail");
        if (failed.length) await recordFinalGaps("acceptance", failed.map(gate => ({
          reason: `Final acceptance gate ${gate.id} failed (exit ${gate.exit}): ${gate.logRef}`,
          source: `Final acceptance gate ${gate.id}`,
        })), failed.map(gate => ({ key: finalAttempt.gate.key, logRef: gate.logRef })));
        loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
        loopReport("gaps", `Final acceptance failed or candidate changed: ${JSON.stringify(receipt)}`);
        continue;
      }
      loop.candidate = candidate(receipt.after);
      loop.phase = "review"; await save();
    }
    if (loop.phase === "review") {
      if (loop.kind !== "final" || !currentAcceptance()) throw new Error("Final review requires current acceptance gates on the same candidate.");
      if (!loop.replayedFinalReview) await reconcileAnalysis();
      progress();
      let reviewDispatchError, reviewDispatchBarrier;
      // reviewPhase owns its fixed+risk angles mirrored over two slots, then synthesis.
      // Replay reconciles each retained call; repeating a key is not observation.
      // Normally dispatch the model-free access verifier directly. A renewed
      // synthesis intention already has a verifier; observe its verified receipt instead.
      const reviewRuns = { all: requests => (requests.every(request => request.agent === "pitako.originals-verifier")
        ? loop.replayedReviewAccess && requests.length === 1 && requests[0].key === loop.replayedReviewAccess.key
          ? observeStatus(loop.replayedReviewAccess.runId, true).then(observed => {
            const { key, runId, agent } = loop.replayedReviewAccess;
            const cause = analysisBarrier(observed, runId);
            if (cause) throw nativeBarrier(cause, { key, runId, agent });
            if (observed?.runId && observed.runId !== runId || observed?.key && ![key, runId].includes(observed.key) ||
                observed?.agent && observed.agent !== agent || !analysisSettled(observed, { key, runId }))
              throw new Error("Renewed review access verifier producer integrity mismatch.");
            return [loop.replayedReviewAccess];
          })
          : dispatch(requests.map(request => ({ ...request, cwd: config.root, reads: false, progress: false })))
        : analysisDispatch(requests.map(request => ({
        ...request, cwd: config.root, reads: false, progress: false,
      }))).then(results => {
        results.forEach((result, index) => usage(result, requests[index].key));
        return results;
      })).catch(error => {
        if (error?.spawnBudgetExhausted || persistenceFailed && error?.nativeBarrier) reviewDispatchError = error;
        if (error?.nativeBarrier && error.nativeReference) reviewDispatchBarrier = error;
        throw error;
      }) };
      const reviewed = loop.review?.status === "completed" && ["clear", "material-gaps"].includes(loop.review.verdict) ? {
        status: "completed", phase: loop.review.phase, references: loop.review.references,
        screening: { verdict: loop.review.verdict, reason: loop.review.reason, assessments: loop.review.unresolved },
      } : await reviewPhase({
        workDescription: `Loop ${loop.number} result — ${(selectedTasks().map(task => task.goal)).map(goal => goal.replace(/\s+/g, " ").trim()).join("; ")}`,
        brief: `${fullContext()}\nReview the COMPLETE authorized result against ALL specs, not director tasks alone.
Admitted COMPLETE plan references: ${canonicalJSON(clone(loop.plan.ref))}.
Assess single-outcome decomposition and necessary dependencies independently; schema cannot certify semantics.
Do not repeat correct completed implementation merely to improve its past decomposition.
Candidate including WIP: ${JSON.stringify(loop.candidate)}.
Actual final checks/result references: ${JSON.stringify(loopResults())}.
Done/obsolete tasks (bounded summary: title or clipped goal and last reason; omitted counts tasks beyond the cap): ${canonicalJSON(loop.completedTasks)}.
Complete goals and histories of every task: ${invocation.backlogPath}.
Authority: spec, frozen amendments and current HUMAN rulings (most recent human source wins; cite it) > DECISION > FINDING > HANDOFF; code wins over any map.
Current Board HUMAN rulings, DECISIONs and authority: ${JSON.stringify(invocation.currentView)}.
${acceptanceBrief()}
No own writer is active. Do not run checks or repair. Only clear screening permits compliance.`,
        target: { kind: "solution", reference: JSON.stringify(loop.candidate),
          material: `Entire designated checkout ${config.root}, immutable full specs above and native work/check artifacts.
Read the actual sources and full referenced reports, not previews. Candidate: ${JSON.stringify(loop.candidate)}.` },
      }, reviewRuns, { prefix: reviewPrefix(), mode: "execute",
        enclosingLoop: loop, persist: save,
        models: invocation.reviewModels,
        decisionReference: { stateKey: key, loop: loop.number, plan: loop.plan.ref, candidate: loop.candidate,
          generation: loop.analysisGenerations?.["final-review"] ?? 1 },
        access: { missionPath: config.missionPath, namespace: `execute-${config.invocation}` },
      });
      if (reviewDispatchError?.nativeBarrier) throw reviewDispatchError;
      if (reviewDispatchBarrier?.nativeDispatch) throw reviewDispatchBarrier;
      if (persistenceFailed) throw new Error(persistenceReason);
      if (reviewDispatchError && loop.halt?.code !== "timeout") throw reviewDispatchError;
      if (reviewed.code === "store-busy")
        return cursorDisposition(executeCursor(), "partial", reviewed.error);
      // A second failed observation must not erase the original lookup refs.
      const reviewRefs = new Map((loop.review?.references ?? []).map(ref => [ref.key, ref]));
      reviewed.references.forEach(ref => reviewRefs.set(ref.key, {
        ...reviewRefs.get(ref.key), ...nativeReference(ref.key, ref), barrier: barrier(ref), reused: ref.reused === true,
      }));
      loop.review = { status: reviewed.status, phase: reviewed.phase,
        verdict: reviewed.screening?.verdict ?? "blocked", reason: excerpt(reviewed.screening?.reason ?? reviewed.error),
        unresolved: reviewed.screening?.assessments?.filter(item => item.material) ?? [],
        nativeFailure: reviewed.nativeFailure ?? null,
        references: [...reviewRefs.values()] };
      // The final review projection becomes the durable native-reference owner.
      // Keep only call identity in the analysis journal, not a second full copy.
      for (const call of loop.analysisCalls ?? []) if (reviewRefs.has(call.key))
        call.ref = { key: call.key, ...(text(call.ref.runId) ? { runId: call.ref.runId } : {}) };
      const reviewBarrier = reviewed.references.map(ref => barrier(ref)).find(Boolean);
      if (reviewBarrier) throw reviewDispatchBarrier?.nativeBarrier === reviewBarrier
        ? reviewDispatchBarrier : nativeBarrier(reviewBarrier);
      if (reviewed.nativeBarrier) throw reviewDispatchBarrier?.nativeBarrier === reviewed.nativeBarrier
        ? reviewDispatchBarrier : nativeBarrier(reviewed.nativeBarrier);
      if (loop.halt?.code === "timeout") return finish(loop.halt.status, loop.halt.reason);
      if (reviewed.code) {
        // The native host key cannot be reissued within this root. Reuse the verified
        // admission binding and the checkout observed by the committed final gate.
        throw Object.assign(new Error(reviewed.error), { code: reviewed.code, recovery: reviewed.recovery,
          epochAdmissionObservation: { version: config.preliminary.version,
            binding: invocation.admissionBinding, checkout: loop.candidate } });
      }
      if (reviewed.status !== "completed" || reviewed.screening?.verdict === "blocked") {
        const reason = reviewed.screening?.reason ?? reviewed.error ?? "Adversarial review blocked; no compliance or repair launched.";
        loop.halt = reviewed.nativeFailure
          ? { status: "partial", ...reviewed.nativeFailure }
          : { status: "blocked", code: "semantic-block", reason: excerpt(reason) };
        await save();
        return finish(loop.halt.status, loop.halt.reason);
      }
      await compactIntegratedReview();
      if (reviewed.screening.verdict !== "clear")
        await recordFinalGaps("review", [{ reason: loop.review.reason }],
          [findingOutput(loop.review.references.find(ref => ref.key.endsWith(".director-synthesis")))]);
      loop.phase = reviewed.screening.verdict === "clear" ? "compliance" : "closing";
      await save();
    }
    if (["compliance", "closing"].includes(loop.phase) && loop.review?.status === "completed") {
      await compactIntegratedReview();
    }
    if (loop.phase === "compliance") {
      if (loop.kind !== "final" || !currentAcceptance() || loop.review?.verdict !== "clear")
        throw new Error("Final compliance requires current acceptance and clear review on the same candidate.");
      if (!loop.replayedFinalReview) await reconcileAnalysis();
      const completedReview = loop.integratedReview;
      const complianceKey = `${generationKey(`${key}.l${loop.number}`, "compliance")}.compliance`;
      const result = await collect(complianceKey, pitakoReviewerAgent(complianceKey),
        { label: "Check whole-spec compliance", phase: "compliance" }, `${fullContext()}
INDIVIDUAL READ-ONLY WHOLE-SPEC COMPLIANCE ANALYSIS. You are ONE fresh analyst, not a council,
director checklist, implementation worker or final presentation agent. No delegation, writes or tests.
Before examining the solution, load and apply verify-behavior. Reconstruct material outcomes
from the authorized request, accepted decisions and complete specs, not the diff, task plan
or existing tests. Distinguish correctness from sufficiency. For each material outcome identify
implementation, current evidence and limits using the existing requirements/reason fields.
Investigate material counterexamples: omitted obligations, shared mistaken assumptions and
unproved connections between tested pieces. Unresolved material gaps prevent fulfillment.
Explain why minor uncertainty cannot compromise the requested outcome. Justify fulfillment
and evidence limits, not test counts; the admitted task plan cannot bound your inventory.
Derive a meaningful inventory of ALL obligations from the COMPLETE selected specs, not a fixed
count or ID convention: include their actual acceptance criteria AND obligations in expected
behavior, constraints, verification and other sections. Use unique source-grounded IDs.
Cite source, reason, current candidate evidence and actual check references for every entry;
not-applicable requires a source-grounded reason. Identify missing obligations as gaps, not omissions.
You are accountable for semantic coverage of the complete specs; script shape validation cannot
certify it. An empty or entirely not-applicable inventory cannot justify fulfilled.
Authority: spec, frozen amendments and current HUMAN rulings (most recent human source wins; cite it) > DECISION > FINDING > HANDOFF; code wins over any map.
Current Board HUMAN rulings, DECISIONs and authority: ${JSON.stringify(invocation.currentView)}.
${acceptanceBrief()}
Candidate INCLUDING WIP: ${JSON.stringify(loop.candidate)}.
Work and actual final mandatory checks: ${JSON.stringify(loopResults())}.
MAIN-SESSION CANCELLATIONS (not human intent): ${JSON.stringify(cancelledScope())}.
Unfulfilled entries must be reported as "cancelled by main-session request" with origin,
never as human intent or fulfilled scope: ${JSON.stringify(unfulfilledCancellations())}.
Reasoned shared adversarial clear: ${JSON.stringify(loop.review)}.
Completed review originals: ${JSON.stringify(completedReview.originals)}.
Read completed originals from their paths and verify SHA-256 before consumption; a missing or mismatched
file blocks with the expected digest, never reconstruct its value from a summary.
Admitted COMPLETE plan references: ${canonicalJSON(clone(loop.plan.ref))}.
Independently assess single-outcome decomposition and dependency completeness against the full spec;
structural validation cannot prove them. Do not repeat correct work to improve past decomposition.
Read the actual full reports and sources via exact refs. Green/TODO/completed is not fulfillment.
Return fulfilled ONLY with reasoned complete requirements coverage, current mandatory checks,
no unresolved material gaps and this SAME candidate. Otherwise gaps or blocked. No post-review repair.`,
        complianceSchema, false, analysisDispatch);
      const value = result?.structuredOutput;
      const complianceRef = loop.compliance?.ref;
      if (barrier(result)) throw nativeBarrier(barrier(result), nativeReference(complianceKey, result), result);
      if (!result?.ok || !value || pitakoAgentFamily(result.agent) !== "reviewer")
        throw new Error(`Compliance lacks a meaningful source/reason/current-evidence requirements inventory. ${excerpt(result?.error ?? result?.output ?? "")}`);
      // The judged candidate is workflow-known (it is in the prompt); never a model echo.
      // Native SDK originals may cross VM realms; hash their JSON value, not their prototype.
      loop.compliance = { ...projection(complianceKey, result), candidate: candidate(loop.candidate),
        original: { key: complianceKey, runId: result.runId,
          path: result.results?.[0]?.savedOutputPath ?? result.results?.[0]?.structuredOutputPath,
          digest: canonicalDigest(clone(value)) },
        reason: excerpt(value?.reason),
        unresolved: Array.isArray(value?.requirements) ? value.requirements.filter(item => ["gap", "blocked"].includes(item?.status))
          .map(item => ({ id: item.id, source: item.source, status: item.status, reason: item.reason })) : [] };
      loop.compliance.ref = { ...complianceRef, ...loop.compliance.ref };
      loop.compliance = closingCompliance(value, loop.compliance.original, result.agent, candidate(loop.candidate), cancelledScope());
      loop.closingPublication.compliance = { key: complianceKey, runId: result.runId };
      if (complianceKey !== loop.closingSeed.complianceKey)
        loop.closingSeed = { ...loop.closingSeed, complianceTimeoutMs: effectiveTimeouts().reviewerMs };
      loop.complianceUsage = result.results?.[0]?.usage;
      if (value.status === "blocked") {
        loop.halt = { status: "blocked", code: "semantic-block", reason: excerpt(value.reason) };
        await save(); return finish("blocked", loop.halt.reason);
      }
      if (loop.compliance.status === "gaps")
        await recordFinalGaps("compliance", loop.compliance.unresolved.length ? loop.compliance.unresolved : [{ reason: loop.compliance.reason }],
          (loop.compliance.unresolved.length ? loop.compliance.unresolved : [null]).map(() => findingOutput(loop.compliance.ref)));
      loop.phase = "closing"; await save();
    }
    if (loop.phase === "closing") {
      if (invocation.intentions?.length) await groupedIO("closingDrain", { operation: "drain" });
      if (!loop.compliance && loop.review?.verdict === "material-gaps") {
        // Adversarial gaps close without a compliance child; synthesis anchors the replay.
        const { key, runId } = loop.review.references.find(ref => ref.key.endsWith(".director-synthesis"));
        dispatchedAction = { kind: "launched", role: "reviewer", key, runId };
      }
      progress();
      const retainedClosing = !!(loop.closing || loop.observation);
       // Reconcile the retained producer first; a new retry key publishes only
       // through the ledger's identical-byte comparison.
       let closeTries = 0;
       while (!loop.closing) {
        closeTries++;
        try {
         const fresh = !loop.observation || budgetRejected(loop.observation.key);
         if (!loop.observation) {
           loop.observation = { invocation: config.invocation, loop: loop.number,
             key: `${key}.l${loop.number}.checkout${loop.checkoutRetry ? `.r${loop.checkoutRetry}` : ""}`, stage: "intention" };
           await save();
         }
         const intention = loop.observation;
         if (intention.invocation !== config.invocation || intention.loop !== loop.number ||
             intention.key !== `${key}.l${loop.number}.checkout${loop.checkoutRetry ? `.r${loop.checkoutRetry}` : ""}`)
           throw new Error("Closing observation intention conflicts with this invocation/loop; inspect the retained exact operation, no replacement dispatch.");
         let observed;
         try {
           if (!loop.closingPublication) throw new Error("Closing publication integrity: missing archive seed reference.");
           observed = fresh ? (await dispatch([{ key: intention.key, agent: "pitako.checkout-observer",
             task: JSON.stringify(loop.closingPublication), cwd: config.root, context: "fresh",
             output: false, outputMode: "inline", outputSchema: false, reads: false, progress: false }]))[0]
             : await observeStatus(intention.ref?.runId ?? intention.key, true);
         } catch (error) {
           if (error.nativeBarrier) error.nativeReference ??= { key: intention.key, agent: "pitako.checkout-observer" };
           intention.failure = { reason: String(error?.message ?? error) };
           if (!persistenceFailed) await save();
           throw error;
         }
         if (intention.ref?.runId && observed?.runId !== undefined && observed.runId !== intention.ref.runId ||
             intention.ref?.asyncDir && observed?.asyncDir !== undefined && observed.asyncDir !== intention.ref.asyncDir)
           throw new Error(`Closing producer identity changed for ${intention.key}; expected ${intention.ref.runId ?? "unavailable"}, observed ${observed?.runId ?? "unavailable"}. Inspect retained native references; no replacement dispatch.`);
         const cause = barrier(observed, intention.ref?.runId ?? intention.key);
         if (cause && (intention.validated || !fresh)) throw nativeBarrier(cause, intention.ref ?? nativeReference(intention.key, observed), observed);
         let observation = intention.validated;
         if (observation) {
           if (intention.stage !== "receipt" || intention.ref?.key !== intention.key ||
               !text(intention.ref?.runId) || !text(intention.ref?.asyncDir) ||
               intention.ref?.agent !== "pitako.checkout-observer" ||
               !text(intention.ref?.externalAdapter?.outputArtifacts?.stdoutPath) ||
               !text(intention.ref?.externalAdapter?.outputArtifacts?.stderrPath) ||
               utf8Bytes(JSON.stringify(observation)) > 61440 || observation.version !== 1 || observation.ok !== true ||
               Object.keys(observation).sort().join(",") !== "checkout,commonDir,ledger,ok,root,store,summaries,version" ||
               observation.root !== invocation.association.root || observation.commonDir !== invocation.association.commonDir ||
               Object.keys(observation.checkout ?? {}).sort().join(",") !== "fingerprint,head" ||
               !candidate(observation.checkout) || !validLoopAnchor(observation.ledger) || !validSummaries(observation.summaries))
             throw new Error(`Invalid retained closing evidence for ${intention.key}: ${JSON.stringify(intention.ref)}. Reconcile the exact original stdout/stderr and producer; no replacement dispatch.`);
         } else {
           if (!fresh && (!observed?.externalAdapter || !observed?.asyncDir))
             throw new Error(`Closing evidence unavailable for ${intention.key}: ${JSON.stringify(intention.ref ?? { key: intention.key })}. Native status is not the original completion payload. Recover the exact original validated evidence from these native references; preserve the pending intention, never infer completion or redispatch.`);
           intention.ref = nativeReference(intention.key, observed);
           intention.stage = "receipt";
           references.push(intention.ref);
           await save();
           if (cause) throw nativeBarrier(cause, intention.ref, observed);
           observation = checkoutTerminalObservation(observed, intention.key, invocation.association, loop.number,
             Math.max(1, loop.archivePending.expected.count) + 1);
           intention.validated = observation;
           await save();
         }
         const producer = intention.ref;
         if (invocation.closeReferences.some(previous => previous.loop !== loop.number &&
             (previous.runId === producer.runId || previous.asyncDir === producer.asyncDir ||
               previous.stdoutPath === producer.externalAdapter.outputArtifacts.stdoutPath ||
               previous.stderrPath === producer.externalAdapter.outputArtifacts.stderrPath)))
           throw new Error("Closing observation reuses another loop's native evidence; inspect the exact producer references before continuation.");
         const oldLedger = invocation.ledger;
         const published = observation.store;
         validateClosingProjection(published, invocation);
         const oldProjection = storeProjection, oldHead = invocation.head;
         storeProjection = { head: published.head, P: published.P };
         invocation.head = clone(published.head);
         invocation.ledger = observation.ledger;
         loop.closing = { candidate: candidate(observation.checkout),
           sameCandidate: same(candidate(observation.checkout), loop.candidate),
           observation, ref: intention.ref };
         intention.stage = "receipt";
         try { await save(); } catch (error) {
           invocation.ledger = oldLedger; invocation.head = oldHead; storeProjection = oldProjection;
           delete loop.closing; throw error;
         }
         intention.stage = "complete";
         delete intention.validated;
        } catch (error) {
          if (error.code && error.code !== "store-busy" || error.terminalPersistence || error.spawnBudgetExhausted ||
              error.ledgerIntegrity || error.nativeBarrier || error.nativeFailure?.code === "capacity" ||
              /Closing archive source fields changed|Invalid retained closing evidence|producer identity changed|reuses another loop/.test(error.message)) throw error;
          if (closeTries >= 3)
            throw error.code === "store-busy" ? error : new Error(`Checkout publication pending: three attempts failed (${error.message}).`);
          persistenceFailed = false; persistenceReason = null;
          // Validated bytes can be admitted again after a state-save cut. Otherwise
          // reobserve and let the ledger reject a changed post-publication retry.
          if (!loop.observation?.validated) {
            loop.checkoutRetry = (loop.checkoutRetry ?? 0) + 1;
            delete loop.observation;
          }
          await save();
        }
       }
      // Recovered evidence predates admission; a freshly dispatched observation does not.
      if (retainedClosing && replay && !same(loop.closing.candidate, currentCandidate)) {
        loop.invalidated = "candidate-changed-after-close";
        loop.closing.sameCandidate = false;
        loop.closing.resumeCandidate = currentCandidate;
      }
      const fulfilled = loop.closing.sameCandidate && loop.review?.verdict === "clear" &&
        loop.compliance?.status === "fulfilled" && same(loop.compliance.candidate, loop.candidate) &&
        currentAcceptance();
      const beforeClose = clone(loop), beforeTotals = clone(invocation.usageTotals);
      loop.outcome = fulfilled ? "complete" : "gaps"; loop.endedAt = Date.now();
      loop.phase = "finished"; activePlan = null;
      loop.archived = true;
      delete loop.archivePending;
      foldLoop(loop.closing.observation.summaries);
      for (let attempt = 1; ; attempt++) {
        try { await save(); persistenceFailed = false; persistenceReason = null; break; } catch (error) {
          if (!error.terminalPersistence && attempt < 3) { persistenceFailed = false; persistenceReason = null; continue; }
          // Keep the published anchor, but do not lose the still-open frame.
          Object.keys(loop).forEach(name => delete loop[name]); Object.assign(loop, beforeClose);
          invocation.usageTotals = beforeTotals;
          throw error;
        }
      }
      if (fulfilled) return await finish("complete", "Whole-spec fulfillment and mandatory checks verified for the current candidate. No more loops required.");
      loopReport("gaps", !loop.closing.sameCandidate ? "Candidate changed; affected checks and analyses are stale."
        : "Material adversarial or compliance gaps remain; next director receives exact evidence.");
    }
  }
} catch (error) {
  let reason = String(error?.message ?? error);
  if (error?.code === EXECUTE_CONTINUATION_INCOMPATIBLE)
    return { ...finish("blocked", reason, true), code: error.code };
  if (invocation?.head && error?.recovery) {
    const cursor = executeCursor();
    try {
      if (await recoverStoreEpoch(error, cursor)) continue;
    } catch (barrierError) {
      return cursorDisposition(cursor,
        ["stopped", "interrupted"].includes(barrierError.nativeBarrier) ? "cancelled" : "blocked",
        String(barrierError.message ?? barrierError));
    }
  }
  // The replacement root owns the fixed key; never save or drain this root again.
  if (error?.code === "superseded") return finish("partial", reason, true);
  if (error?.code === "wrong-cwd") return finish("blocked", "Execute cursor belongs to the wrong cwd.", true);
  if (canSaveBudgetExhaustion(error)) {
    try {
      return await finishBudgetExhaustion();
    } catch (saveError) { reason += ` ${String(saveError?.message ?? saveError)}`; }
  }
  if (error?.hostHalt) {
    hostHalt = error.hostHalt;
    const cursor = !admissionValidated && retainedCursor?.halt?.stage === "timeout" && reviewerTimeoutAction(retainedCursor.action) &&
        matchesCursorRequest(retainedCursor)
      ? { ...retainedCursor, hostHalt: hostHaltCursor(retainedCursor, hostHalt) }
      : invocation?.head ? executeCursor() : null;
    const halt = hostHaltReport(cursor?.action, hostHalt);
    if (!cursor) {
      references.push(error.hostRef);
      return finish(halt.status, halt.reason);
    }
    try {
      await persistState(stateKey, cursor);
      return hostHaltDisposition(cursor, halt);
    }
    catch (saveError) {
      persistenceFailed = true;
      persistenceReason = `Essential persistence failed; host observation could not be retained: ${String(saveError?.message ?? saveError)}`;
    }
    return finish(halt.status, halt.reason);
  }
  // Child timeout is partial, NOT invocation cancellation. Native Stop is reported
  // only from an observed barrier, not inferred from an exception's task wording.
  const stopped = ["stopped", "interrupted"].includes(error?.nativeBarrier) ||
    !!error?.nativeBarrier && /\.task-(reviewer|synthesis)$/.test(error.nativeReference?.key ?? "");
  if (stopped) reason = `Execution cancelled: ${reason}`;
  const status = stopped ? "cancelled" : error?.nativeBarrier ? "blocked" :
    loop?.halt ? loop.halt.status : error?.nativeFailure || persistenceFailed ? "partial" : "blocked";
  if (loop?.halt?.reason && !reason.includes(loop.halt.reason))
    reason = `${loop.halt.reason} ${reason}`;
  if (loop && admissionValidated && retainUnstartedDispatch(error, reason)) {
    reason = loop.halt.reason;
  } else if (loop && admissionValidated && error?.nativeBarrier) {
    const ref = error.nativeReference ?? loop.attempt?.launch ?? loop.halt?.ref ?? { key };
    if (loop.halt && loop.attempt) loop.attempt.interruption ??= clone(loop.halt);
    const genericHalt = loop.halt = { status, code: "native-barrier", cause: error.nativeBarrier,
      reason: excerpt(reason), ref: clone(ref) };
    const stage = Object.keys(noRunBarrier).find(stage => noRunBarrier[stage] === error.nativeBarrier);
    if (stage && dispatchedAction?.kind === "launched" && !dispatchedAction.runId &&
        (!error.nativeReference || error.nativeReference.key === dispatchedAction.key && !error.nativeReference.runId))
      loop.halt = noRunHalt(dispatchedAction, { stage, reason: excerpt(reason) });
    if (["stopped", "interrupted", "native permission denial"].includes(error.nativeBarrier) &&
        dispatchedAction?.kind === "pending" && pitakoAgentFamily(ref.agent) === "loop-io" && ref.runId &&
        ref.key.replace(/\.r\d+$/, "") === dispatchedAction.opKey)
      loop.halt = loopIOHalt(ref, error.nativeBarrier);
    if (["stopped", "interrupted", "native permission denial"].includes(error.nativeBarrier) &&
        dispatchedAction?.kind === "launched" && dispatchedAction.role === "worker" && dispatchedAction.runId &&
        ref.key === dispatchedAction.key && ref.runId === dispatchedAction.runId &&
        !hostHalt && (storeProjection?.P.control.operation?.operation === "baseline" ||
          storeProjection?.P.control.operation?.operation === "selection"))
      loop.halt = workerInterruptionHalt(dispatchedAction, error.nativeBarrier);
    if (stopped && ["stopped", "interrupted"].includes(error.nativeBarrier) &&
        dispatchedAction?.kind === "launched" && dispatchedAction.role === "execution-director" && dispatchedAction.runId &&
        loop.plan?.ref.key === dispatchedAction.key && loop.plan.ref.runId === dispatchedAction.runId &&
        !hostHalt)
      loop.halt = directorInterruptionHalt(dispatchedAction, error.nativeBarrier);
    if (["stopped", "interrupted", "native permission denial"].includes(error.nativeBarrier) &&
        text(ref.runId) && !hostHalt &&
        loop.analysisCalls?.some(call => call.key === ref.key && call.ref.runId === ref.runId)) {
      dispatchedAction = { kind: "launched", role: "reviewer", key: ref.key, runId: ref.runId };
      loop.halt = closingInterruptionHalt(dispatchedAction, error.nativeBarrier);
    }
    const witness = error.settlementHalt;
    const reviewedSealer = witness?.ref.agent === "pitako.checkpoint-sealer" &&
      dispatchedAction?.kind === "launched" && /\.task-(reviewer|synthesis)$/.test(dispatchedAction.key) &&
      ["stopped", "interrupted", "native permission denial"].includes(witness.cause);
    if (witness && !reviewedSealer && loop.halt === genericHalt) {
      retainSettledNativeHalt(witness);
      reason = loop.halt.reason;
    }
  }
  if (loop && !persistenceFailed && admissionValidated) {
    if (error?.viewOverflowHalt) {
      loop.halt = error.viewOverflowHalt;
      if (loop.halt.ref) retainHaltProducer(loop.halt.ref, "loop-io");
    }
    if (error?.backlogConflict) loop.halt = { status: "blocked", code: "backlog-conflict", reason: excerpt(reason),
      ...(error.conflictRef ? { ref: error.conflictRef, originalDigest: error.originalDigest } : {}) };
    loop.halt = loop.halt ?? { status, ...(error?.nativeFailure ?? {
      code: error?.nativeBarrier ? "native-barrier" : "recovery", reason: excerpt(reason),
      ...(error?.nativeBarrier ? { cause: error.nativeBarrier } : {}),
    }) };
    try { await save(); } catch (saveError) {
      reason += `${error?.nativeBarrier ? ` Observed native barrier: ${error.nativeBarrier}.` : ""} ${String(saveError?.message ?? saveError)}`;
    }
  }
  return finish(status, reason);
} finally {
  // Join original native promises even when helpers await derived chains.
  await Promise.allSettled(nativeCalls);
}
}
