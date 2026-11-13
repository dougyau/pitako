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
  specRefs: list(string), dependsOn: list(string), gates: { ...list(commandSchema), minItems: 1 },
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
const key = `invoke-${config.invocation}`;
const references = [];
const nativeCalls = [];
function retainNativeCall(promise) {
  nativeCalls.push(promise);
  return promise;
}
const utf8Bytes = value => encodeURIComponent(value).replace(/%[0-9A-F]{2}|[^%]/g, "x").length;
const clone = value => JSON.parse(JSON.stringify(value));
const excerpt = value => typeof value === "string" ? value.slice(0, 360) : "";
function same(a, b) {
  // JSON object key order is not part of the published definition.
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
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
function nativeReference(childKey, result) {
  const ref = { key: childKey };
  // Review publication and control witnesses are projected only for review children;
  // other children keep the stable reference used for recovery reconciliation.
  const review = childKey.includes(".review.");
  // Review retains a failed original once in its own state; keep only the diagnostic here.
  if (review && text(result?.error)) ref.error = result.structuredOutput === undefined ? result.error
    : result.error.split("\n\nOutput:\n")[0]
      .replaceAll(JSON.stringify(result.structuredOutput, null, 2), "[retained failed original]")
      .replaceAll(JSON.stringify(result.structuredOutput), "[retained failed original]");
  for (const field of ["agent", "runId", "asyncDir", "outputReference", "outputArtifactPath", "outputPathMapping", "artifactPaths", "externalAdapter",
    ...(review ? ["model", "nativeKey", "workflowKey", "outputSaveError", "metadataSaveError", "exitCode", "timedOut", "terminalOutcome", "stopped", "interrupted", "detached", "recovery", "toolBudgetBlocked", "state"] : [])])
    if (result?.[field] !== undefined) ref[field] = result[field];
  // Native acceptance metadata is large and constant for read-only reviewers; only
  // its recovery barrier is control evidence. Per-result debug paths stay in the
  // native run, reachable through asyncDir/artifactPaths, not in mission state.
  const recovery = item => item?.acceptance?.recovery !== undefined ? { acceptance: { recovery: item.acceptance.recovery } } : {};
  if (review) Object.assign(ref, recovery(result));
  if (!review) {
    const witnesses = result?.results?.filter(entry => text(entry.structuredOutputPath) || text(entry.savedOutputPath))
      .map(entry => Object.fromEntries(["structuredOutputPath", "savedOutputPath"].filter(field => text(entry[field])).map(field => [field, entry[field]])));
    if (witnesses?.length) ref.results = witnesses;
    return ref;
  }
  if (result?.key !== undefined && result.key !== childKey && result.key !== result.runId) ref.nativeKey = result.key;
  const witnesses = result?.results?.map(entry => Object.fromEntries(
    ["index", "key", "agent", "runId", "workflowKey", "savedOutputPath", "outputReference", "structuredOutputPath",
      "outputSaveError", "metadataSaveError", "exitCode", "terminalOutcome", "state", "stopped", "interrupted", "timedOut", "detached", "recovery", "toolBudgetBlocked"]
      .filter(field => entry[field] !== undefined).map(field => [field, entry[field]]).concat(Object.entries(recovery(entry)))));
  if (witnesses?.length) ref.results = witnesses;
  return ref;
}
function barrier(result, ref) {
  if (!result) return null;
  for (const field of ["stopped", "interrupted"])
    if (result[field]) return field;
  for (const field of ["stopped", "interrupted"])
    if (result.results?.some(child => child[field])) return field;
  for (const field of ["detached", "recovery"])
    if (result[field]) return field;
  if (["running", "queued", "pending", "paused", "stopped", "interrupted", "detached", "recovery", "rejected"].includes(result.state)) return result.state;
  if (result.results?.some(child => child.stopped || child.interrupted || child.detached ||
      child.acceptance?.recovery || child.toolBudgetBlocked)) return "native child barrier";
  if (/Blocked by pi-subagents permission rule:/.test(result.error ?? "")) return "native permission denial";
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
function nativeBarrier(cause, ref) {
  const error = new Error(`Positive native barrier: ${cause}`);
  error.nativeBarrier = cause;
  if (ref) error.nativeReference = clone(ref);
  return error;
}
function nativeFailure(childKey, error, result) {
  const message = String(error?.message ?? error);
  // 0.83.0 exposes admission failures as text, not a typed capacity code.
  // Match its complete receipt only at the native call boundary, never model prose.
  const capacity = /^Run fan-out limit reached at .+ \(\d+\/\d+ used; \d+ requested, \d+ remaining\)\. No children from this admission group were started\. Start a new top-level run or raise config\.maxSubagentSpawnsPerRun\.$/.test(message) ||
    /^Active async run capacity exhausted: \d+\/\d+ used\.$/.test(message) ||
    /^Subagent spawn limit reached for this session \(\d+\/\d+ used, \d+ requested\)\. \d+ remaining; the declared run cannot fit, so no children were started\. Grant budget explicitly from the root interactive session or start a new session\.$/.test(message);
  return { code: capacity ? "capacity" : "native-dispatch", reason: excerpt(message),
    ref: nativeReference(childKey, result) };
}
function dispatch(requests) {
  return Promise.resolve().then(() => {
    if (requests.some(request => budgetRejected(request.key))) {
      invocation.budgetRejectedKeys = invocation.budgetRejectedKeys.filter(childKey => !requests.some(request => request.key === childKey));
      // Consume the no-launch evidence before launch; an uncertain new call must reconcile normally.
      return save();
    }
  }).then(() => retainNativeCall(runs.all(requests))).then(results => {
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
      invocation.budgetRejectedKeys = [...new Set([...(invocation.budgetRejectedKeys ?? []), ...rejected.map(result => result.key)])];
      throw Object.assign(new Error(rejected[0].error), { spawnBudgetExhausted: true });
    }
    results.forEach((result, index) => {
      const cause = barrier(result);
      if (resolution && ["stopped", "interrupted", "native permission denial"].includes(cause))
        resolution.currentBarrier = { cause, ref: nativeReference(requests[index].key, result) };
      if (!result?.ok) {
        const cause = nativeFailure(requests[index].key, result?.error ?? "Native child failed.", result);
        if (cause.code === "capacity") result.nativeFailure = cause;
      }
    });
    return results;
  }).catch(error => {
    if (error?.spawnBudgetExhausted) throw error;
    if (error?.nativeBarrier) {
      if (resolution && ["stopped", "interrupted", "native permission denial"].includes(error.nativeBarrier))
        resolution.currentBarrier = { cause: error.nativeBarrier, ref: { key: requests[0].key } };
      throw error;
    }
    if (/^Blocked by pi-subagents permission rule:/.test(String(error?.message ?? error))) {
      if (resolution) resolution.currentBarrier = { cause: "native permission denial", ref: { key: requests[0].key }, observedError: String(error.message ?? error) };
      throw nativeBarrier("native permission denial");
    }
    const cause = nativeFailure(requests[0].key, error);
    const failure = new Error(cause.reason);
    failure.nativeFailure = cause;
    throw failure;
  });
}
function budgetRejected(childKey) {
  return invocation?.budgetRejectedKeys?.includes(childKey);
}
function observeStatus(ref, retainUnknown = false) {
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
    // Best-effort observer unavailability is unknown, not activity or settlement.
    if (retainUnknown) return { ok: false, state: "unknown", output: message };
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
    error.hostHalt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked", code: "host-observation",
        reason: error?.message === `Host command '${grant.key}' failed: Command stopped because the workflow was aborted.`
          ? "Native host abort/failure observation is ambiguous; retain the unknown cause for bounded reconstruction under current native authority."
          : "Read-only host inspection failed; retain its observation for bounded reconstruction under current native authority.",
        ref: { key: grant.key }, command: grant.command,
        observedError: String(error?.message ?? error), request: hostRequest(),
        ...(receipt?.state !== undefined ? { observedState: receipt.state } : {}),
        ...(error.nativeBarrier ? { observedBarrier: error.nativeBarrier } : {}),
        ...(receipt?.outputPath !== undefined ? { outputReference: receipt.outputPath } : {}) };
    if (attempt === 3) error.hostHalt.reason += ` Three inspection attempts failed: ${String(error?.message ?? error)}`;
    throw error;
  });
}
function hostRequest() {
  return { missionId: config.missionId, missionPath: config.missionPath,
    invocation: config.invocation, root: config.root, id: config.id,
    inspectionCommand: config.inspections[0].command, sourceRefs: config.sourceRefs ?? [] };
}
function capture(current) {
  const preliminary = config.preliminary;
  if (!preliminary || preliminary.version !== 1 || current.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(current.binding ?? "") || current.binding !== preliminary.binding ||
      preliminary.id !== config.id || typeof preliminary.content !== "string" ||
      !preliminary.content || utf8Bytes(preliminary.content) > 39936 || !candidate(current.checkout))
    throw new Error(`Preliminary/native admission binding mismatch for ${preliminary?.source ?? "unavailable source"}; expected ${preliminary?.binding ?? "unavailable"}, observed ${current.binding ?? "unavailable"}. Reconcile the disputed selection, content and physical identity; explicitly prepare admission with the intended version, never auto-select newer content. After admission preserve the original snapshot and restore reliable exact bytes; deliver desired changes as a human addendum. Native barriers still require native reconciliation.`);
  if (config.recovery?.digest !== current.recoveryDigest ||
      (current.recoveryDigest !== undefined && !/^[a-f0-9]{64}$/.test(current.recoveryDigest)))
    throw new Error(`Retained recovery originals changed between preliminary capture and native admission; expected ${config.recovery?.digest ?? "unavailable"}, observed ${current.recoveryDigest ?? "unavailable"}. Preserve exact producer references and the admitted snapshot; inspect those originals and reconcile the exact pending operation, never redispatch or silently recapture.`);
  const witness = current.checkpointObservation;
  if (witness !== undefined && (!witness || typeof witness !== "object" || Array.isArray(witness) ||
      !text(witness.key) || !text(witness.taskId) || !Number.isSafeInteger(witness.attempt) || witness.attempt < 1 ||
      !Number.isSafeInteger(witness.loop) || witness.loop < 1 || !Number.isSafeInteger(witness.cursor) || witness.cursor < 0 ||
      !(Object.keys(witness).sort().join(",") === "attempt,cursor,evidence,key,loop,taskId" && /^[a-f0-9]{64}$/.test(witness.evidence) ||
        Object.keys(witness).sort().join(",") === "attempt,cursor,error,key,loop,taskId" && text(witness.error))))
    throw new Error("Invalid native checkpoint observation; retain the pending unit and inspect the exact native admission receipt before recovery.");
  return { metadata: { root: preliminary.root, commonDir: preliminary.commonDir,
    selected: { source: preliminary.source, digest: preliminary.digest }, checkout: current.checkout,
    retainedAnalyses: config.recovery?.originals ?? [], ...(witness ? { checkpointObservation: witness } : {}) }, content: preliminary.content };
}
let invocation, loop, activePlan, currentCandidate, checkpointObservation, replay = false;
let hostHalt, resolution, hostReconstruction;
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
function persistState(stateKey, value, optionalPlan = null) {
  // Freeze once and serialize saves: a retried older projection must not overwrite a newer receipt.
  const frozen = clone(value);
  const projections = [frozen, ...(optionalPlan ? [{ ...frozen, activePlan: clone(optionalPlan) }] : [])];
  function writeProjection(index, attempt = 1) {
    return Promise.resolve().then(() => state.set(stateKey, projections[index])).catch(error => {
      if (index === 1 && /^Mission state exceeds the 256 KiB limit/.test(String(error?.message ?? error))) return;
      if (!transientSaveError(error)) throw Object.assign(error, {
        terminalPersistence: deterministicSaveError(error),
      });
      if (attempt === 3) throw new Error(`Three state-save attempts failed: ${String(error?.message ?? error)}`);
      // set re-reads disk under its lock; get is cached and cannot confirm a failed write.
      return writeProjection(index, attempt + 1);
    });
  }
  const pending = saveTail.then(() => writeProjection(0)).then(() =>
    projections.length === 2 ? writeProjection(1).catch(error => {
      throw Object.assign(new Error(`Optional active-plan persistence failed; dispatch halted: ${String(error?.message ?? error)}`),
        { optionalPersistence: true, terminalPersistence: error.terminalPersistence === true });
    }) : undefined);
  saveTail = pending.catch(() => {});
  return pending;
}
function maxCycles() { return invocation?.association?.maxCycles ?? null; }
// The native setter measures the whole file as indented JSON (pi-subagents
// workflow-state.js, 256 KiB). The quarter left covers other keys and later saves.
const DRAIN_BEFORE_ARCHIVE_BYTES = 192 * 1024;
function stateBytes() { return utf8Bytes(JSON.stringify({ [key]: { ...invocation, activePlan: null } }, null, 2)); }
function save() {
  if ((loop?.phase === "closing" && !loop.closing || loop?.outcome === "gaps") && !loop.archivePending && !loop.archived)
    loop.archivePending = frozenLoopArchive(loop.phase !== "closing");
  if (loop?.phase === "closing" && loop.archivePending && !loop.archived) closingRecord();
  // The native setter measures the ENTIRE merged file, including unrelated keys.
  // Essential state is committed first. One optional identical active plan cannot
  // displace snapshot, frozen descriptor, progress, or historical records.
  const essential = { ...invocation, activePlan: null };
  return persistState(key, essential).then(() => { emitTodoSnapshot(); }).catch(error => {
    if (error.optionalPersistence) throw error;
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
  return save().then(() => dispatch([{ key: observerKey, agent: "pitako.request-observer",
    context: "fresh", cwd: config.root, task: JSON.stringify({ invocation: config.invocation, cursor }),
    output: false, outputMode: "inline", outputSchema: false, reads: false, progress: false,
  }])).then(([result]) => {
    references.push(nativeReference(observerKey, result));
    const cause = barrier(result);
    if (cause) throw nativeBarrier(cause);
    if (!result?.ok || result.agent !== "pitako.request-observer" || !text(result.runId) ||
        !Array.isArray(result.results) || result.results.length !== 1 || result.results[0].exitCode !== 0 ||
        typeof result.output !== "string" || utf8Bytes(result.output) > 65536 ||
        [result, ...result.results].some(item => item.error || item.outputPartial || item.truncation || item.timedOut || item.processSignal))
      throw new Error("Execute request observation lacks a complete successful result; no worker dispatched.");
    return admitRequests(JSON.parse(result.output), cursor, records, settling);
  });
}
function admitRequests(page, cursor = 0, records = [], settling = false) {
    if (page.version !== 1 || page.ok !== true || page.invocation !== config.invocation ||
        !Array.isArray(page.requests) || page.requests.some(request => request.v !== 1 ||
          request.invocation !== config.invocation || !text(request.requestId) || !text(request.taskId) ||
          !["cancel", "delete"].includes(request.kind) || !/^[a-z][a-z0-9_-]{0,31}$/.test(request.origin ?? "")) ||
        !(page.next === null || Number.isSafeInteger(page.next) && page.next === cursor + page.requests.length && page.next > cursor))
      throw new Error(`Invalid execute request observation: ${page.reason ?? "invalid page"}; no worker dispatched.`);
    records.push(...page.requests);
    if (page.next !== null) return observeMainRequests(page.next, records, settling);
    for (const request of records) {
      const task = selectedTasks().find(task => task.id === request.taskId);
      const retained = task && invocation.tasks[task.id];
      if (!retained || retained.cancel || retained.completed) continue;
      retained.cancel = { requestId: request.requestId, origin: request.origin, kind: request.kind,
        reason: `cancelled by main-session request (origin: ${request.origin}; ${request.kind})` };
      (invocation.pendingCancellations ??= []).push({ taskId: task.id, requestId: request.requestId,
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
function analysisSettled(observed, ref) {
  let lines = typeof observed?.output === "string" ? observed.output.split(/\r?\n/) : [];
  if (lines[0] === `Status target: run ${ref.runId ?? ref.key}` &&
      /^Spawn budget:/.test(lines[1] ?? "") && /^Active async capacity:/.test(lines[2] ?? ""))
    lines = lines.slice(3);
  return observed?.ok && (observed.state === "complete" ||
    ((lines[0] === `Run: ${ref.runId ?? ref.key}` || lines[0] === `Nested run: ${ref.runId ?? ref.key}`) && lines.includes("State: complete")));
}
function retainedReadOnlyOriginal(observed, ref) {
  // Management status is not the original. Prefer its complete native body;
  // only fall back to the exact associated original read by the inspector.
  const original = inspectedAnalyses.find(value => value.key === ref.key && value.runId === ref.runId);
  const retainedBarrier = barrier(original, ref.runId ?? ref.key);
  if (retainedBarrier) throw nativeBarrier(retainedBarrier);
  if (original?.error && original.error !== "Complete retained analysis original unavailable.")
    throw new Error(original.error);
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
    const cause = barrier(observed, ref);
    if (cause) throw nativeBarrier(cause, call.ref);
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
    const verifiedProjection = verifiedTaskOriginal === taskOriginal && taskOriginal?.projection &&
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
  const calls = [...(loop.analysisCalls ?? [])].filter(call => call.key !== `${key}.l${loop.number}.demand-observation`);
  for (const ref of [...(loop.review?.references ?? []), loop.compliance?.ref].filter(Boolean)) {
    if (!calls.some(call => call.key === ref.key))
      calls.push({ key: ref.key, stage: "receipt", ref: { key: ref.key, ...(text(ref.runId) ? { runId: ref.runId } : {}) },
        barrier: ref.barrier ?? barrier(ref) });
  }
  if (!hasIntentions && loop.halt?.code === "native-barrier" && !calls.some(call => call.barrier))
    return Promise.reject(nativeBarrier(loop.halt.cause ?? "analysis receipt unavailable; settlement uncertain"));
  loop.analysisCalls = [...(loop.analysisCalls ?? []).filter(call => call.key === `${key}.l${loop.number}.demand-observation`), ...calls];
  // Observe the whole retained group before a missing sibling may be launched.
  return calls.reduce((settled, call) =>
    settled.then(() => budgetRejected(call.key) ? undefined : analysisResults.get(call.key) ?? observeAnalysis(call)), Promise.resolve()).then(() => {
      if (loop.analysisCalls?.length && loop.halt?.code === "native-barrier") delete loop.halt;
    });
}
function interruptedReceipt(observed, ref) {
  if ([observed, ...(observed?.results ?? [])].some(item => /Blocked by pi-subagents permission rule:/.test(item?.error ?? "")))
    throw nativeBarrier("native permission denial", ref);
  if (!observed || !text(observed.runId) || (ref.runId && ref.runId !== observed.runId))
    throw new Error("Interrupted producer identity/settlement uncertain; no fresh work dispatched.");
  if ((ref.agent && observed.agent !== ref.agent) ||
      (observed.key && observed.key !== ref.key && observed.key !== ref.runId))
    throw new Error("Interrupted producer/key identity conflicts with retained reference.");
  if ([observed, ...(observed.results ?? [])].some(item =>
    ["running", "queued", "pending", "paused", "detached", "recovery"].includes(item.state) ||
    item.detached || item.recovery || item.acceptance?.recovery || item.toolBudgetBlocked))
    throw nativeBarrier("interrupted producer remains active or unsettled");
  const cause = barrier(observed, ref.runId ?? ref.key);
  const historical = ["stopped", "interrupted"].includes(cause);
  // Native ok is completed work, not a launch receipt. Missing inventory and
  // terminal-looking labels cannot settle a stopped/denied producer.
  if ((cause && !historical) || ((historical || !observed.ok) && !closedProducerProcesses(observed)) || (!cause && !observed.ok))
    throw nativeBarrier(cause ?? "interrupted producer settlement/result uncertain");
  return historical;
}
// A pending v6 task must retain its selected identity and checkpoint intention.
function pendingCheckpointUnit() {
  return loop?.phase === "implementation" && loop.attempt?.checkpoint && !loop.attempt.result &&
    selectedTasks()[loop.cursor]?.id === loop.attempt.taskId;
}
const reconciledRecoveries = new Map();
function reconcileRetainedRecoveries() {
  const needsPlan = loop.phase === "implementation" && loop.attempt?.checkpoint && !loop.attempt.result && !loop.task;
  return (needsPlan ? recoverPlan().then(found => {
    if (!found) throw new Error("Complete admitted task definition unavailable before continuation.");
  }) : Promise.resolve()).then(() => {
    const operations = resolution.operations ?? [];
    if (pendingCheckpointUnit())
      return; // A1: old read-only queries need not be salvaged before rollback.
    // Only this continuation's loop and relevant unfinished observations. A
    // completed historical recovery is not a universal inventory prerequisite.
    const retained = (loop.recoveries ?? []).filter(item => item.stage !== "observed" ||
      !["recovered", "lost"].includes(item.disposition) ||
      operations.some(ref => ref.key === item.source?.key));
    return retained.reduce((previous, recovery) => previous.then(() =>
      inspectRecovery(recovery.phase, recovery.source, recovery).then(value => {
        if (value.status === "unresolved")
          throw new Error(`Retained recovery unresolved: ${value.reason}`);
        if (recovery.phase === "loop-plan") {
          if (value.status === "recovered") {
            if (!value.originalAvailable || !value.original)
              throw new Error("Retained plan recovery lacks the complete original.");
            planAuthority(value.original);
            if (activePlan && !same(activePlan, value.original)) planConflict("Conflicting complete backlog selection values.");
            validatePlan(value.original, loop.number, loop.manifest);
          } else if (loop.plan.stage === "admitted")
            throw new Error("Retained admitted plan recovery lacks the complete original.");
        } else if (recovery.phase === "checkpoint") {
          checkpointOriginal(value, loop.attempt);
        } else {
          if (value.status !== "recovered" || !value.originalAvailable || !value.original)
            throw new Error(`Interrupted operation lacks an exact settled original receipt: ${value.reason}`);
          interruptedReceipt(value.original, recovery.source);
        }
        reconciledRecoveries.set(recovery.subject, value);
        // Complete-value validation precedes resolution application, not just the
        // inspector's observed disposition. Essential persistence gates effects.
        return save();
      })), Promise.resolve());
  });
}
function reconcileInterruptedOperations() {
  // Human input is associated with one retained interruption. It never grants
  // native permissions, even when a later management view omits that denial.
  if (!same(resolution.halt, loop.halt)) throw nativeBarrier(loop.halt.cause);
  if (loop.halt.cause === "native permission denial") throw nativeBarrier(loop.halt.cause);
  if (loop.halt.ref?.agent === "pitako.loop-io") {
    const ref = loop.halt.ref;
    const pending = [...Object.values(invocation), ...Object.values(loop), ...Object.values(loop.attempt ?? {})]
      .find(value => value?.dispatched && value.ref?.key === ref.key &&
        ["advance", "selection", "close", "drain"].includes(value.input?.operation));
    if (!pending || pending.ref.runId !== ref.runId)
      throw new Error("Grouped operation reference conflicts with its retained intention.");
    return observeStatus(ref.runId ?? ref.key, true).then(observed => {
      const cause = observed?.state === "unknown" ? null : barrier(observed, ref.runId ?? ref.key);
      if (cause && !["stopped", "interrupted"].includes(cause)) throw nativeBarrier(cause, ref);
      if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
          (observed?.agent && observed.agent !== ref.agent))
        throw new Error("Grouped operation producer/run identity conflicts with its intention.");
      resolution.observations = [projection(ref.key, observed ?? { ok: false, state: "unknown" })];
      resolution.stage = confirmedPausePending() ? "accepted" : "applied";
      // A fresh native key resumes the same on-disk sub-step markers.
      if (pending.stage !== "receipt") {
        pending.retry++; pending.dispatched = false; delete pending.ref;
      }
      if (pending.input?.operation === "drain") pending.reconciled = ref.key;
      if (loop.attempt?.seal && loop.attempt.close === pending)
        loop.attempt.seal.reconciled = ref.key;
      delete loop.halt;
      delete loop.outcome;
      return save();
    });
  }
  if (invocation.sealPending && loop.halt.ref?.agent === "pitako.execution-ledger") {
    const ref = loop.halt.ref;
    return observeStatus(ref.runId ?? ref.key, true).then(observed => {
      const cause = barrier(observed, ref.runId ?? ref.key);
      if (cause && !["stopped", "interrupted"].includes(cause)) throw nativeBarrier(cause, ref);
      if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
          (observed?.agent && observed.agent !== "pitako.execution-ledger"))
        throw new Error("Archiver producer/run identity conflicts with pending seal.");
      resolution.observations = [projection(ref.key, observed)];
      resolution.stage = confirmedPausePending() ? "accepted" : "applied";
      delete loop.halt;
      delete loop.outcome;
      return save();
    });
  }
  if (loop.halt.ref?.agent === "pitako.checkpoint-sealer" && loop.attempt?.seal && loop.attempt.stage !== "result") {
    // Observe the settled sealer before input applies; normal replay then
    // re-observes the worker and dispatches a fresh seal under the next key.
    const ref = loop.halt.ref;
    return observeStatus(ref.runId ?? ref.key, true).then(observed => {
      const cause = observed?.state === "unknown" ? null : barrier(observed, ref.runId ?? ref.key);
      if (cause && !["stopped", "interrupted"].includes(cause)) throw nativeBarrier(cause, ref);
      if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
          (observed?.agent && observed.agent !== "pitako.checkpoint-sealer"))
        throw new Error("Sealer producer/run identity conflicts with the pending seal.");
      resolution.observations = [projection(ref.key, observed ?? { ok: false, state: "unknown" })];
      resolution.stage = "applied";
      loop.attempt.seal.reconciled = ref.key;
      delete loop.halt;
      delete loop.outcome;
      return save();
    });
  }
  if (pendingCheckpointUnit()) {
    const ref = loop.attempt.launch ?? { key: loop.attempt.key };
    if (!resolution.operations?.some(item => same(item, ref)))
      throw new Error("Continuation input does not identify the pending checkpoint writer.");
    // Observe before applying input. Admission and removal of only its old Stop
    // share one durable save, so a cut cannot erase an unobserved denial.
    return observeStatus(ref.runId ?? ref.key, true).then(observed => {
      assertFallbackProducer(observed, ref);
      resolution.observations = [projection(ref.key, observed)];
      resolution.stage = "applied";
      loop.attempt.interruption ??= clone(loop.halt);
      delete loop.outcome;
      delete loop.halt;
      return save();
    });
  }
  const observations = [];
  let historicalBarrier = false;
  return (resolution.operations ?? []).reduce((previous, ref) => previous.then(() =>
    observeStatus(ref.runId ?? ref.key).then(observed => {
      if ([observed, ...(observed?.results ?? [])].some(item => /Blocked by pi-subagents permission rule:/.test(item?.error ?? "")))
        throw nativeBarrier("native permission denial", ref);
      const cause = barrier(observed, ref.runId ?? ref.key);
      if (cause && !["stopped", "interrupted"].includes(cause))
        throw nativeBarrier(cause);
      if (observed?.runId && closedProducerProcesses(observed)) return observed;
      if (observed?.ok && text(observed.runId) && observed.structuredOutput && !cause) return observed;
      const retained = loop.recoveries.find(item => item.source?.key === ref.key);
      // A different subject must not replace an already launched observation.
      // Payload recovery is not an original operation settlement receipt.
      if (retained && retained.phase !== "interrupted-operation")
        throw new Error("Retained payload recovery does not settle the interrupted producer; no replacement query authorized.");
      return (retained ? Promise.resolve(reconciledRecoveries.get(retained.subject))
        : inspectRecovery("interrupted-operation", ref)).then(value => {
        if (value.status !== "recovered" || !value.original)
          throw new Error(`Interrupted operation lacks an exact settled original receipt: ${value.reason}`);
        return value.original;
      });
    }).then(observed => {
      const historical = interruptedReceipt(observed, ref);
      historicalBarrier ||= historical;
      observations.push(projection(ref.key, observed));
    })), Promise.resolve()).then(() => {
      if (!observations.length || !historicalBarrier)
        throw new Error("No authoritative settled historical interruption to discharge; retain the pending obligation.");
      resolution.observations = observations;
      resolution.stage = "applied";
      loop.outcome = "gaps";
      delete loop.halt;
      return save();
    });
}
function analysisDispatch(requests) {
  return Promise.allSettled(requests.map(request => Promise.resolve().then(() => {
    loop.analysisCalls ??= [];
    let call = loop.analysisCalls.find(entry => entry.key === request.key);
    if (call && !budgetRejected(call.key)) return analysisResults.get(call.key) ?? observeAnalysis(call);
    if (!call) {
      call = { key: request.key, stage: "intention", ref: { key: request.key } };
      loop.analysisCalls.push(call);
    }
    return save().then(() => {
      if (persistenceFailed) throw new Error(persistenceReason);
      return dispatch([request]);
    }).then(([result]) => {
      call.stage = "receipt";
      call.ref = request.key.includes(".review.") || /\.task-(reviewer|synthesis)$/.test(request.key) || request.key === `${key}.l${loop.number}.demand-observation`
        ? nativeReference(request.key, result)
        : { key: request.key, ...(text(result?.runId) ? { runId: result.runId } : {}) };
      call.barrier = barrier(result);
      return save().then(() => {
        if (call.barrier) throw nativeBarrier(call.barrier,
          request.key.endsWith(".demand-observation") || /\.task-(reviewer|synthesis)$/.test(request.key) ? call.ref : undefined);
        analysisResults.set(call.key, result);
        return result;
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
    const failure = settled.find(item => item.status === "rejected" && !item.reason?.spawnBudgetExhausted) ??
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
    output: `${childKey}.json`, outputMode: "file-only", reads: false, progress: false,
    skill: ["verify-behavior", ...(scopeDiscipline ? ["scope-discipline"] : [])],
    task: `${label}\n\n${scopeDiscipline ? "Read and apply scope-discipline before expanding work or verification; preserve admitted tasks and gates.\n" : ""}${task}`, outputSchema,
    // Keep awaited final-result admission; live steps reach the main session from the child session file.
    ...(implementation ? { timeoutMs: 14400000,
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
function planConflict(reason) {
  loop.halt = { status: "blocked", code: "semantic-block", reason, ref: clone(loop.plan.ref) };
  throw new Error(reason);
}
function planAuthority(value, result) {
  if (!value || !(value.select === null || text(value.select)) || !Array.isArray(value.changes) || !text(value.reason)) planConflict("Invalid backlog selection.");
  if (result && ((result.agent && result.agent !== "pitako.execution-director") ||
      !text(result.runId) || (loop.plan.ref.runId && result.runId !== loop.plan.ref.runId)))
    planConflict("backlog selection producer/run identity conflict.");
  if (result && text(result.output) && /^[\s]*\{/.test(result.output)) {
    let binding;
    try { binding = JSON.parse(result.output); } catch (_) { planConflict("Invalid complete backlog selection binding JSON."); }
    if (!same(binding, value)) planConflict("Changed/conflicting backlog selection binding; no edits authorized.");
  }
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
function loopIORequest(childKey, input) {
  return { key: childKey, agent: "pitako.loop-io", cwd: config.root, context: "fresh", output: false,
    outputMode: "inline", outputSchema: false, reads: false, progress: false,
    control: LOOP_IO_CONTROL, ...(input.operation === "close" ? { timeoutMs: 14400000 } : {}),
    task: JSON.stringify(input) };
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
  queueIntention({ key: input.key, operation: "apply", slot, taskId: loop.task?.id,
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
      if (intention.input.record.kind === "loop") {
        if (!validSummaries(value.summaries)) throw new Error("Invalid drained loop summaries.");
        loop.archived = true; delete loop.archivePending; delete loop.archiveQueued;
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
  pending.input ??= { ...clone(input), root: config.root, invocation: config.invocation, key: pending.key,
    receipts: invocation.receiptReference ? [clone(invocation.receiptReference)] : [],
    ...(input.operation !== "drain" ? { requests: { cursor: 0 } } : {}) };
  const intentions = pending.admitted ? [] : (invocation.intentions ?? []).slice(0, pending.intentionCount).map(transportIntention);
  return loopIO(slot, { ...pending.input, intentions }, owner).then(transport => {
    const reference = receiptReference(transport), projection = transport.projection;
    if (!projection || projection.invocation !== config.invocation || !Array.isArray(projection.steps) ||
        input.operation !== "drain" && projection.operation !== input.operation)
      throw new Error("Invalid grouped loop-io projection.");
    if (input.operation !== "drain") {
      const names = input.operation === "advance" ? ["drain", "prepare", "requests"]
        : input.operation === "selection" ? ["drain", "apply", "requests", ...(pending.input.baseline ? ["baseline"] : [])]
        : ["drain", "requests", "gate", "seal", ...(pending.input.nextBaseline ? ["nextRequests", "nextBaseline"] : [])];
      if (!same(projection.steps.map(step => step.operation), names) ||
          projection.steps.some(step => step.key !== `${pending.key}.${step.operation}`))
        throw new Error("Grouped loop-io step order differs from its intention.");
    }
    if (!pending.admitted) {
      const before = clone(invocation);
      if (input.operation === "drain") admitDrain(transport, intentions);
      else {
        const drain = projection.steps[0];
        if (drain?.operation !== "drain" || drain.key !== `${pending.key}.drain`) throw new Error("Missing drain-first receipt.");
        admitDrain(drain.result, intentions);
      }
      invocation.intentions = (invocation.intentions ?? []).slice(pending.intentionCount);
      invocation.receiptReference = reference;
      pending.admitted = true;
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
function admitBaseline(intent, receipt) {
  if (typeof receipt?.captured !== "boolean") throw new Error("Invalid grouped baseline receipt.");
  if (!receipt.captured) return null;
  return { ...clone(intent), baseline: candidate(receipt.candidate) };
}
function advanceLoop(slot = "advance", number = loop.number) {
  if (loop[slot]?.stage === "receipt" && !loop[slot].receipt?.projection && !invocation.currentView) {
    // A new observation is not a replay of the completed immutable prepare.
    const generation = (loop[slot].generation ?? 0) + 1;
    loop[slot] = { key: `${key}.l${loop.number}.${slot}.v${generation}`, generation, retry: 0, stage: "intention" };
  }
  const complete = invocation.intentions?.findLast(entry => entry.slot === "settlement" && entry.complete);
  return groupedIO(slot, { operation: "advance", prepare: { specId: config.id,
    previousConfirmedUnit: complete?.taskId ?? invocation.lastBacklogUnit ?? null, loop: number } }).then(transport => {
    const prepared = groupedStep(transport, "prepare");
    invocation.backlogPath = prepared.path; invocation.backlogDigest = prepared.digest;
    invocation.excludedScope = Object.fromEntries((prepared.cancelledScope ?? []).map(task => [task.id, task]));
    invocation.currentView = prepared.view; invocation.boardTopicId = prepared.view.topicId;
    if (number === loop.number) loop.prepare = { stage: "receipt", receipt: clone(prepared) };
    else invocation.preparedNext = { stage: "receipt", receipt: clone(prepared) };
    return observeGroupedRequests(transport).then(() => {
      // Keep the ordinary projections, not a second copy of all grouped evidence.
      loop[slot].receipt = receiptReference(transport);
      delete loop[slot].input;
      return save();
    });
  });
}
// Runtime operations have durable intentions and fresh retry keys, like gate.
function loopIO(slot, input, owner = loop) {
  const pending = owner[slot] ??= { key: slot === "baselineIO" ? `${input.intent.key}.baseline` : `${key}.l${loop.number}.${slot}${slot === "selection" && loop.directorRetry ? ".d1" : ""}`, retry: 0, stage: "intention" };
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
      return save().then(() => dispatch([loopIORequest(childKey, input)]));
    }).then(([result]) => {
      pending.ref = nativeReference(childKey, result);
      const cause = barrier(result, childKey);
      if (cause) throw nativeBarrier(cause, pending.ref);
      if (result?.nativeFailure) throw Object.assign(new Error(result.nativeFailure.reason),
        { nativeFailure: result.nativeFailure });
      let receipt;
      const last = result.output?.trim().split("\n").at(-1);
      try { if (utf8Bytes(last ?? "") <= 61440) receipt = JSON.parse(last); } catch (_) { /* Missing transport output is retried. */ }
      if (receipt?.error === "loop-io" && receipt.ledgerIntegrity === true && text(receipt.reason))
        throw Object.assign(new Error(`Ledger integrity requires human reconciliation: ${receipt.reason}`), { ledgerIntegrity: true });
      if (receipt?.error === "loop-io") {
        const semantic = receipt.selectionRejected || receipt.replayRejected || receipt.viewOverflow ||
          /backlog-conflict:|integrity|digest mismatch|replay differs|completed .* changed|exceeds 61440/.test(receipt.reason ?? "");
        if (!semantic && pending.retry < 2) {
          pending.retry++; delete pending.ref; return save().then(run);
        }
        throw Object.assign(new Error(receipt.viewOverflow && input.operation === "close"
          ? "HUMAN + DECISION overflow: ask the human to consolidate current Board HUMAN rulings and decisions"
          : receipt.reason), { selectionRejected: receipt.selectionRejected === true,
          replayRejected: receipt.replayRejected === true, viewOverflow: receipt.viewOverflow === true,
          backlogConflict: receipt.reason?.startsWith("backlog-conflict:") });
      }
      if (!result.ok || result.agent !== "pitako.loop-io" || !text(result.runId) ||
          result.key !== undefined && result.key !== childKey || result.state !== undefined || result.terminalOutcome ||
          ["advance", "selection", "close", "drain"].includes(input.operation) &&
            (!text(result.asyncDir) || !text(result.externalAdapter?.outputArtifacts?.stdoutPath) ||
              !text(result.externalAdapter?.outputArtifacts?.stderrPath)) ||
          [result, ...(result.results ?? [])].some(item => item.error || item.outputSaveError || item.metadataSaveError ||
            item.transcriptError || item.outputPartial || item.truncation || item.timedOut || item.processSignal) ||
          !Array.isArray(result.results) || result.results.length !== 1 || result.results[0].exitCode !== 0 || !receipt) {
        if (pending.retry >= 2) throw new Error(`loop-io ${slot} has no terminal receipt: ${result.error ?? childKey}`);
        pending.retry++; delete pending.ref; return save().then(run);
      }
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
      return save().then(() => slot === "selection" ? { ...projection, selected: loop.task } : projection);
    }).catch(error => {
      if (persistenceFailed || error.nativeFailure?.code !== "native-dispatch" || pending.retry >= 2) throw error;
      return observeStatus(pending.ref?.runId ?? childKey, true).then(observed => {
        const cause = barrier(observed, pending.ref?.runId ?? childKey);
        if (cause) throw nativeBarrier(cause, pending.ref ?? { key: childKey, agent: "pitako.loop-io" });
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
  // Retained pre-compaction missions are read in place, never migrated.
  const legacy = receipt && typeof receipt.selected === "object" && loop.taskBacklogDigest === undefined;
  if (!receipt || (legacy ? !same(receipt.selected, loop.task)
    : receipt.selected !== (loop.task?.id ?? null) || receipt.digest !== loop.taskBacklogDigest))
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
function admitSettlement(value, intention) {
    invocation.backlogDigest = value.digest; invocation.currentView = null;
    if (intention.complete) invocation.lastBacklogUnit = intention.taskId;
    if (loop.settlement) loop.settlement.applied = true;
    if (value.needsDecision) {
      loop.halt = { status: "needs-decision", code: "needs-decision", ...clone(value.needsDecision),
        reason: `Task ${value.needsDecision.taskId} reached two stalls. Metric series: ${JSON.stringify(value.needsDecision.metricSeries)}. Stall diagnoses: ${JSON.stringify(value.needsDecision.diagnoses)}. Human decision required: edit the backlog or deliver an amendment, then relaunch or unblock through the existing routes.` };
    }
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
  return `CURRENT HUMAN RESOLUTIONS (accepted input, not new permissions): ${JSON.stringify([
    ...retainedResolutions(),
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
function retainDemandSources(latest) {
  invocation.demandSources = (invocation.demandSources ?? []).filter(item => item.loop === latest ||
    (invocation.demandObservations ?? []).some(observation => observation.loop - 1 === item.loop));
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
  const verified = retained.length ? loopIO("demandOriginals", { operation: "reviewOriginals", originals: retained }) : Promise.resolve();
  const childKey = `${key}.l${loop.number}.demand-observation`;
  return verified.then(() => collect(childKey, "pitako.reviewer", { label: "Observe inherited demands", phase: "director" }, `${fullContext()}
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
      invocation.demandObservations = [...(invocation.demandObservations ?? []).filter(item => item.loop !== loop.number),
        { loop: loop.number, ref }].slice(-3);
      retainDemandSources(loop.number - 1);
      // The native receipt is already durable; the director intention saves this projection.
      return { ref, body: value };
    });
}
function inspectRecovery(kind, ref, retained) {
  // Subject identity comes from the frozen work, not a replaceable output path
  // or query key. There is one finite observation route for this subject/stage.
  // The authorized replacement director has its own finite recovery route.
  const planSubject = ref.key === `${key}.l${loop.number}.director.d1` ? "loop-plan:d1" : "loop-plan";
  const subject = kind === "checkpoint" ? `checkpoint:${loop.attempt.taskId}:${loop.attempt.number}` : kind === "interrupted-operation" ? `interrupted-operation:${ref.key}` : planSubject;
  if (loop.recoveries.some(item => !text(item.subject)))
    return Promise.reject(new Error("Retained recovery lacks immutable subject/stage; no replacement query or migration authorized."));
  let recovery = loop.recoveries.find(item => item.subject === subject);
  const existing = !!recovery;
  const producer = kind === "loop-plan" ? loop.plan?.ref : ref;
  if ((retained && retained !== recovery) || !["loop-plan", "interrupted-operation", "checkpoint"].includes(kind) ||
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
  // Persist intent before the external query. An uncertain launch is reconciled
  // by status only: repeating runs.all with the same key is not reattachment.
  return (existing && !budgetRejected(recoveryKey) ? observeStatus(recovery.ref.runId ?? recoveryKey).then(result => {
    if ((recoveryRunId && result?.runId && result.runId !== recoveryRunId) ||
        (result?.agent && result.agent !== "pitako.execution-inspector") ||
        (result?.key && result.key !== recoveryKey && result.key !== recoveryRunId))
      throw new Error("Recovery producer/run identity conflict.");
    const cause = barrier(result, recovery.ref.runId ?? recoveryKey);
    if (cause) throw nativeBarrier(cause);
    return retainedReadOnlyOriginal(result, recovery.ref);
  }) : save().then(() =>
    collect(recoveryKey, "pitako.execution-inspector",
    { label: kind === "checkpoint" ? "Recover writer checkpoint"
      : kind === "interrupted-operation" ? "Recover interrupted operation" : "Recover complete execution plan", phase: "recovery" },
    `EXCEPTIONAL READ-ONLY ${kind} recovery. No tests, writes or delegation.
${fullContext()}
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
For interrupted-operation recovery, original must be the ORIGINAL COMPLETE native operation receipt,
not the agent's output value. Read only the exact already-retained producer references above.
Require actual terminal/settlement evidence; a completed label alone is insufficient. Preserve every
original field, including Stop/denial. If the receipt or settlement proof is unavailable, return unresolved,
not a reconstructed receipt. Do not derive artifact paths from keys or search unrelated locations.
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
      if (cause) throw nativeBarrier(cause);
      if (existing && (!text(result?.runId) || !result?.structuredOutput || (recoveryRunId && result.runId !== recoveryRunId)))
        throw new Error("Recovery settlement/result uncertain; no replacement query authorized.");
      const value = result?.structuredOutput;
      if (!result?.ok || !value || !Array.isArray(value.provenance) ||
          !value.provenance.length || !value.provenance.every(text) || !text(value.reason) ||
          !["recovered", "lost", "conflict", "unresolved"].includes(value.status))
        throw new Error("Recovery has no authoritative complete observation.");
      if (text(result.output) && /^[\s]*\{/.test(result.output)) {
        let binding;
        try { binding = JSON.parse(result.output); } catch (_) { throw new Error("Invalid complete recovery binding JSON."); }
        if (!same(binding, value)) throw new Error("Changed/conflicting recovery binding.");
      }
      const observedProjection = projection(recoveryKey, result);
      Object.assign(recovery, observedProjection, { stage: "observed",
        ref: { ...recovery.ref, ...observedProjection.ref },
        disposition: value.status, reason: excerpt(value.reason), provenance: value.provenance });
      // The full native original remains at its exact ref. Save its disposition
      // before admission/cursor movement; never persist a reconstructed payload.
      return save().then(() => {
        if (value.status === "conflict" || value.binding === "changed" ||
            value.comparison === "different-full-json")
          throw new Error(`Changed/conflicting recovery evidence: ${value.reason}`);
        return value;
      });
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
  const historicalStop = cause === "stopped" && resolution?.loop === loop.number && !loop.archived && ["accepted", "applied"].includes(resolution?.stage) &&
    !resolution.currentBarrier && resolution.halt?.cause === "stopped" &&
    resolution.operations?.some(item => item.key === ref.key && item.runId === ref.runId);
  if (cause && cause !== "interrupted" && !historicalStop) throw nativeBarrier(cause, ref);
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
function checkpointFallback(observed, ref, task) {
  const descriptor = loop.attempt;
  assertFallbackProducer(observed, ref);
  if (!descriptor.checkpoint || loopResults().some(result => result.taskId === task.id && result.status === "complete"))
    throw new Error("Checkpoint fallback cannot restore a completed task or missing checkpoint.");
  const witness = checkpointObservation;
  if (witness && (witness.key !== descriptor.key || witness.taskId !== task.id || witness.attempt !== descriptor.number ||
      witness.loop !== loop.number || witness.cursor !== loop.cursor))
    throw new Error("Checkpoint observation conflicts with pending unit.");
  if (witness?.error) {
    const reason = `Checkpoint observation unavailable: ${witness.error}`;
    loop.halt = { status: "blocked", code: "checkpoint-integrity", reason, ref: clone(ref) };
    throw new Error(reason);
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
  // A restoring writer that published nothing leaves exactly its dispatch-time
  // evidence. Only current human input naming that exact writer renews it, once:
  // the renewed attempt has a new key that this input does not name.
  const renewal = !!descriptor.restore && !!evidence && evidence === descriptor.restore.evidence &&
    resolution?.loop === loop.number && !loop.archived && ["accepted", "applied"].includes(resolution.stage) &&
    !resolution.currentBarrier && resolution.operations?.some(item => item.key === descriptor.key);
  if (lastRestore && !renewal && (!evidence || frame.evidence.includes(evidence) || prior.some(item => item.evidence === evidence ||
      pauseRestoration && !item.evidence &&
        same(item.confirmedPause, descriptor.result?.checkpoint?.confirmation ?? lastRestore.authority?.confirmedPause ?? lastRestore.confirmedPause)))) {
    const error = new Error("Restoration remains pending with no new checkpoint evidence; reconcile the exact operation or supply material progress, no replacement writer authorized.");
    error.nativeFailure = { code: "recovery", reason: error.message, ref: clone(ref) };
    throw error;
  }
  if (renewal) resolution.stage = "applied";
  checkpointObservation = undefined;
  const manifest = `${config.root}/.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json`;
  // The modifying worker reads and validates these exact bytes through the owned
  // helper before any effect. No model inspector/result rescue is a prerequisite.
  const checkpoint = { key: descriptor.checkpoint.key, manifest };
  const sources = [clone(descriptor.checkpoint), ...(frame.sources ?? []).filter(source => source.key !== descriptor.checkpoint.key)].sort((a, b) => b.attempt - a.attempt);
  const confirmedUnit = descriptor.restore?.authority?.confirmedUnit ?? confirmedUnitForPending();
  const observations = sources.map(source => ({ key: source.key,
    manifest: `${config.root}/.pi/subagents/checkpoints/${source.key}/manifest.json` }));
  if (confirmedUnit) observations.push({ key: confirmedUnit.checkpointRef.split("/").at(-2),
    manifest: confirmedUnit.checkpointRef.replace(/unit\.json$/, "manifest.json") });
  descriptor.fallback = { stage: "admitted", source: clone(ref),
    observation: observed === undefined ? { state: "unknown", reason: "Public writer status unavailable" } : clone(observed),
    checkpoint: clone(checkpoint) };

  loop.attempt = { taskId: task.id, index: loop.cursor, number: descriptor.number + 1,
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
    (frame.sources ??= []).push(clone(source));
  }
  // New material checkpoint evidence resolves only the prior technical suspension.
  // Native Stop/permission barriers were checked above and are never cleared here.
  if (loop.halt?.code === "recovery") { delete loop.halt; delete loop.outcome; }
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
  const bounded = content => {
    let result = "", remaining = 2048;
    for (const point of typeof content === "string" ? content.toWellFormed() : "") {
      const size = utf8Bytes(point);
      if (size > remaining) break;
      result += point; remaining -= size;
    }
    return result;
  };
  value.knowledge = {
    findings: Array.isArray(value.knowledge?.findings) ? value.knowledge.findings.filter(text).slice(0, 8).map(bounded) : [],
    handoff: bounded(value.knowledge?.handoff),
  };
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
    if (observed.restored) value.restoreReceipt = clone(observed.restored);
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
  const review = descriptor.taskReview?.synthesis?.projection;
  if (review?.notes) value.diagnosis = `${value.diagnosis.slice(0, 200)}\nNon-blocking inherited notes: ${review.notes.path}`.slice(0, 360);
  if (review && !review.admitted) {
    value.remaining = review.remaining?.length ? review.remaining : review.blocking.length
      ? review.blocking : ["Resolve task review scores or spec-exclusion conflict."];
    value.diagnosis = review.diagnosis || value.remaining.join("; ").slice(0, 360);
    value.revival = review.revival || value.diagnosis;
    value.usefulProgress = !invocation.taskFrame.reviewRepair?.exhausted;
  }
  const repair = invocation.taskFrame.reviewRepair;
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
  const intents = invocation.taskFrame.reviewIntents ??= [];
  if (!intents.some(intent => intent.key === descriptor.key)) intents.push(clone(descriptor.checkpoint));
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
  const base = { ...projection(descriptor.key, result), taskId: descriptor.taskId, attempt: descriptor.number,
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
    knowledge: clone(value.knowledge), gateFailures: value.diagnosis.slice(0, 4096),
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
  if (["recovery", "native-barrier"].includes(loop.halt?.code) &&
      !(resolution?.stage === "accepted" && same(resolution.halt, loop.halt))) delete loop.halt;
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
const RECEIVED_RESULT_LIMIT = 65536;
function retainReceived(result) {
  if (barrier(result) || !result?.ok || !result.structuredOutput || !text(result.runId)) return;
  const received = clone({ ok: true, agent: result.agent, key: result.key, runId: result.runId,
    structuredOutput: result.structuredOutput,
    ...(text(result.output) && /^[\s]*\{/.test(result.output) ? { output: result.output } : {}),
    ...(Array.isArray(result.results) ? { results: result.results.map(entry => ({ agent: entry?.agent, exitCode: entry?.exitCode })) } : {}) });
  if (utf8Bytes(JSON.stringify(received)) <= RECEIVED_RESULT_LIMIT) loop.attempt.received = received;
}
// A positive barrier or another producer keeps the existing route; only the
// same settled launch, without its payload in this observation, is completed.
function receivedResult(observed, ref) {
  const received = loop.attempt.received;
  if (!received || received.runId !== ref.runId ||
      barrier(observed, ref.runId ?? ref.key) || observed?.structuredOutput ||
      (observed?.runId && observed.runId !== received.runId)) return observed;
  return { ...clone(ref), ...clone(received) };
}
function sealerKey(attemptKey, retry) {
  return `${attemptKey}.seal${retry ? `.r${retry}` : ""}`;
}
let settledTaskSealer;
// A retained seal intention is observed before any fallback, recovery or re-seal.
// Grouped closes resume verified markers; legacy seals keep the fresh-dispatch route.
function observePendingSealer() {
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
        (observed?.agent && observed.agent !== ref.agent))
      throw new Error("Sealer producer/run identity conflicts with the pending seal.");
    if (loop.attempt.taskReview?.synthesis && ref.agent === "pitako.checkpoint-sealer" &&
        observed?.ok && observed.output) {
      const receipt = JSON.parse(observed.output);
      if (receipt.outcome === "sealed" && !same(candidate(receipt.candidate), currentCandidate))
        throw new Error("Current candidate differs from the settled task sealer; recovery required.");
      if (receipt.outcome === "sealed") settledTaskSealer = { key, result: observed };
    }
  });
}
// Gate intentions and receipts survive relaunch; a saved seal never reruns gates.
function verifyAttempt(descriptor, task, value, reuse) {
  const pending = descriptor.gate ??= { key: `${descriptor.key}.gate`, stage: "intention", retry: 0 };
  if (pending.stage === "receipt") return Promise.resolve(pending.receipt);
  if (descriptor.seal) return Promise.reject(new Error("Seal intention has no durable gate receipt; recovery required."));
  const gateTask = pending.task ??= { id: task.id,
    gates: task.gates ?? task.checks.map(check => ({ id: check.id, command: check.command, cwd: check.cwd,
      timeoutMs: check.timeoutMs ?? 1800000 })), metric: task.metric ?? null,
    progress: loop.metricSeries ?? task.progress ?? { nonImproving: 0, last5: [] } };
  function runGate() {
    const gateKey = `${pending.key}${pending.retry ? `.r${pending.retry}` : ""}`;
    return Promise.resolve().then(() => {
      if (!pending.dispatched || budgetRejected(gateKey)) return;
      return observeStatus(pending.ref?.runId ?? gateKey, true).then(status => {
        const cause = barrier(status, pending.ref?.runId ?? gateKey);
        if (cause) throw nativeBarrier(cause, pending.ref);
        if (status?.ok && status.output) return status;
      });
    }).then(observed => {
      if (observed) return [observed];
      // Admission exhaustion proves no child launched and preserves this key.
      pending.stage = "intention"; pending.dispatched = true;
      return save().then(() => dispatch([{ ...loopIORequest(gateKey, {
        operation: "gate", root: config.root, specId: config.id, invocation: config.invocation,
        loop: loop.number, attempt: descriptor.number, key: gateKey, task: gateTask,
        workerStatus: value.status, writerSettled: true, checkpoint: descriptor.checkpoint, knowledge: value.knowledge, ...(reuse ? { reuse } : {}),
      }), timeoutMs: 14400000 }]));
    }).then(([result]) => {
      pending.ref = nativeReference(gateKey, result);
      const cause = barrier(result, gateKey);
      if (cause) return save().then(() => { throw nativeBarrier(cause, pending.ref); });
      let receipt;
      if (typeof result?.output === "string") {
        const last = result.output.trim().split("\n").at(-1);
        if (utf8Bytes(last ?? "") <= 8192) {
          try { receipt = JSON.parse(last); } catch (_) { /* Malformed output is not gate evidence. */ }
        }
      }
      if (receipt?.viewOverflow === true) return save().then(() => {
        throw Object.assign(new Error("HUMAN + DECISION overflow: ask the human to consolidate current Board HUMAN rulings and decisions"), { viewOverflow: true });
      });
      const failures = [result, ...(result?.results ?? [])].filter(Boolean);
      const terminal = result?.ok && result.agent === "pitako.loop-io" && text(result.runId) &&
        (result.key === undefined || result.key === gateKey) && !result.state && !result.terminalOutcome &&
        Array.isArray(result.results) && result.results.length === 1 && result.results[0].exitCode === 0 &&
        failures.every(item => !item.error && !item.outputSaveError && !item.metadataSaveError && !item.transcriptError &&
          !item.outputPartial && !item.truncation && !item.timedOut && !item.processSignal &&
          (item.exitCode === undefined || item.exitCode === 0));
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
      pending.receipt = receipt; pending.stage = "receipt";
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

function acceptanceResults() {
  const receipt = loop?.finalAttempt?.gate?.receipt;
  const humanIds = new Set((receipt?.view?.posts ?? []).filter(post => post.type === "HUMAN").map(post => post.id));
  const blocking = [], excepted = [];
  for (const result of receipt?.gates ?? []) {
    const exception = loop.acceptance?.find(command => command.id === result.id)?.exception;
    if (exception && humanIds.has(exception.humanRef)) excepted.push({ ...result, ...exception });
    else blocking.push(result);
  }
  return { blocking, excepted };
}
function acceptanceBrief() {
  return `Excepted acceptance results: ${JSON.stringify(acceptanceResults().excepted)}.
Acceptance history: ${JSON.stringify(loop.selection?.receipt?.acceptanceHistory ?? [])}.
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
function closeAttempt(descriptor, task, value) {
  const savedReceipt = descriptor.close?.stage === "receipt";
  const gateTask = descriptor.gate?.task ?? { id: task.id, gates: task.gates ?? task.checks.map(check => ({ id: check.id,
    command: check.command, cwd: check.cwd, timeoutMs: check.timeoutMs ?? 1800000 })),
    metric: task.metric ?? null, progress: loop.metricSeries ?? task.progress ?? { nonImproving: 0, last5: [] } };
  const next = checkpointIntent(task.id, descriptor.number + 1,
    `${key}.l${loop.number}.t${loop.cursor + 1}.a${descriptor.number + 1}`);
  const admitted = next.progress.admitted[task.id] ??= [];
  if (!admitted.includes("continue")) admitted.push("continue");
  // These variants are inert until the workflow admits the matching pause.
  const sealed = clone(next); sealed.progress.previous = null;
  const nextBaselines = descriptor.close?.input?.nextBaseline ?? { sealed, observed: next };
  const seal = { v: 1, intent: descriptor.checkpoint,
    ...(descriptor.restore ? { restoreSources: descriptor.restore.sourceKeys.map(sourceKey => {
      const source = invocation.taskFrame.sources.find(item => item.key === sourceKey);
      if (!source) throw new Error("Missing authenticated restoration source intent.");
      return source;
    }) } : {}) };
  return groupedIO("close", { operation: "close",
    gate: { root: config.root, specId: config.id, invocation: config.invocation,
      loop: loop.number, attempt: descriptor.number, key: `${descriptor.key}.gate`, task: gateTask,
      workerStatus: value.status, writerSettled: true, checkpoint: descriptor.checkpoint, knowledge: value.knowledge },
    seal: { unit: seal, pause: seal }, nextBaseline: nextBaselines }, descriptor).then(transport => {
    const gate = groupedStep(transport, "gate"), selected = groupedStep(transport, "seal");
    if (!validGateReceipt(gate.receipt, gateTask, value.status) ||
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
    descriptor.gate = { key: `${descriptor.key}.gate`, stage: "receipt", ref: clone(descriptor.close.ref),
      receipt: { ...gate.receipt, contextPeak: transport.projection.contextPeak } };
    const requests = groupedStep(transport, "nextRequests"), baseline = groupedStep(transport, "nextBaseline");
    const earlier = groupedStep(transport, "requests");
    if (!Number.isSafeInteger(earlier.count) || earlier.count < 0 || !Array.isArray(requests.requests) ||
        requests.requests.length < earlier.count)
      throw Object.assign(new Error("Close request snapshot integrity conflict."), { checkpointIntegrity: true });
    const outcome = selected.receipt.outcome;
    const variant = kind === "pause" && value.status !== "blocked" && ["sealed", "observed"].includes(outcome) &&
      requests.next === null && !requests.requests.some(request => request.taskId === task.id) ? outcome : null;
    if (baseline.variant !== variant || baseline.sealOutcome !== outcome || baseline.captured !== (variant !== null))
      throw Object.assign(new Error("Close next-baseline selection differs from workflow evidence."), { checkpointIntegrity: true });
    if (savedReceipt && !same(currentCandidate, candidate(gate.receipt.after))) {
      const reason = "Current candidate differs from the saved close gate receipt; recovery required, gates must not be rerun.";
      loop.halt = { status: "blocked", code: "recovery", reason, ref: clone(descriptor.close.ref) };
      return save().then(() => { throw new Error(reason); });
    }
    currentCandidate = candidate(gate.receipt.after);
    loop.metricSeries = clone(gate.receipt.progress);
    invocation.currentView = clone(gate.receipt.view);
    invocation.boardTopicId = gate.receipt.view.topicId;
    return observeGroupedRequests(transport, true, requests).then(() => {
      descriptor.foldedNextBaseline = variant ? admitBaseline(nextBaselines[variant], baseline) : null;
      return save();
    }).then(() => selected);
  });
}
const taskReviewFinding = object({
  summary: string, introducedByDelta: { type: "boolean" }, affectsTask: { type: "boolean" },
  evidence: string,
});
taskReviewFinding.properties.predatesTask = { type: "boolean" };
const taskReviewAnswer = object({
  verdict: string, score: { type: "integer", minimum: 0, maximum: 10 },
  findings: { type: "array", items: taskReviewFinding },
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
        !text(answer.verdict) || !Array.isArray(answer.findings) ||
        answer.score < 10 && !answer.findings.length) throw new Error("Invalid anchored task review answer.");
    scores[name] = answer.score;
    for (const finding of answer.findings) {
      if (!text(finding.summary) || !text(finding.evidence) ||
          typeof finding.introducedByDelta !== "boolean" || typeof finding.affectsTask !== "boolean")
        throw new Error("Invalid task review finding.");
      (finding.introducedByDelta || finding.affectsTask || carried && finding.predatesTask !== true
        ? blocking : notes).push(finding.summary.slice(0, 256));
    }
  }
  if (typeof value.conflict !== "boolean") throw new Error("Invalid task review conflict.");
  return { scores, admitted: Object.values(scores).every(score => score >= 9) && !blocking.length && !value.conflict,
    blocking, conflict: value.conflict, notes: notes.length ? reference : null,
    ...(Array.isArray(value.remaining) && value.remaining.every(text)
      ? { remaining: value.remaining.slice(0, 4).map(item => item.slice(0, 256)) } : {}),
    ...(text(value.diagnosis) ? { diagnosis: value.diagnosis.slice(0, 360) } : {}),
    ...(text(value.revival) ? { revival: value.revival.slice(0, 360) } : {}) };
}
function reviewTask(descriptor, task) {
  const review = descriptor.taskReview ??= {};
  const originals = [review.reviewer, review.synthesis].filter(Boolean);
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
  const intents = [...new Map([...(invocation.taskFrame.reviewIntents ?? []), ...(invocation.taskFrame.sources ?? []), descriptor.checkpoint]
    .map(intent => [intent.key, intent])).values()].sort((a, b) => a.attempt - b.attempt);
  return access.then(() => loopIO("delta", { operation: "taskDelta", root: config.root, invocation: config.invocation,
    intents }, descriptor)).then(delta => {
    if (delta.unsettled === true) { review.unsettled = true; return; }
    if (!Array.isArray(delta.touched) || !Array.isArray(delta.netChanged) || delta.netChanged.length > 200 ||
        ![...delta.touched, ...delta.netChanged].every(text)) throw new Error("Invalid task delta evidence.");
    const diff = delta.diff;
    if (delta.touched.length ? !diff || typeof diff.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(diff.sha256) ||
        diff.path !== `${config.root}/.pi/subagents/execute/${config.invocation}/task-deltas/diff-${diff.sha256}.patch` ||
        ![diff.bytes, diff.lines, diff.omitted].every(value => Number.isSafeInteger(value) && value >= 0) ||
        diff.lines < 1 : diff !== null) throw new Error("Invalid task delta evidence.");
    if (!delta.touched.length) return;
    const carried = !!task.remaining?.length || (task.progress?.last5?.length ?? 0) > 0 ||
      (task.progress?.nonImproving ?? 0) > 0;
    const brief = `Read-only per-task review. Read the complete immutable spec and its Scope and Exclusions:
${invocation.association.source} (SHA-256 ${invocation.association.digest}).
${fullContext()}
Frozen amendments: ${JSON.stringify(invocation.amendments ?? [])}.
Task definition: ${JSON.stringify(task)}.
Delta reference: ${JSON.stringify(diff)}.
a/ = slot baseline before attempt 1, b/ = current candidate.
Verify sha256 with file_sha256 first; a missing or mismatched diff is a blocking finding of uncertain provenance.
Read the absolute path with read offset paging, using the index start lines (grep skips the gitignored .pi/).
Non-rendered statuses are declared limits: do not claim to have reviewed unavailable bytes, and do not deduct for that alone.
git_diff and watchdog_diff compare with HEAD and include earlier loops' WIP.
The diff covers only this loop; for carried tasks, earlier-loop work is visible only in current source.
Changed-file evidence: ${JSON.stringify(delta)}.
Observed gate results (command definitions and status, exit, bounded tail, log reference):
${JSON.stringify({ definitions: task.gates, results: descriptor.gate.receipt.gates })}.
Unavailable checks are unobserved; do not deduct for that alone. carried: ${carried}.
Answer completeness against expectedResult (for corrections, every admitted finding path);
correctness against achieving the result without introducing failures; scope against goal,
specRefs and the spec Scope/Exclusions. Scope limits edit locations, not required outcomes.
Distinguish correctness from sufficiency; verify every required task outcome against current evidence.
For each question give a verdict, score 0-10, and concrete source-evidenced findings.
Anchors: 10 = fully satisfied, no finding; 9 = satisfied with minor concrete non-blocking findings;
7-8 = material unmet outcome; 4-6 = major defects; 0-3 = absent or fundamentally wrong.
Every score below 10 requires a concrete finding. Every finding states introducedByDelta,
affectsTask (leaves goal or expectedResult undone), summary and evidence.
Inherited-only findings never block: prove they predate the task and do not affect its goal.
Uncertain provenance blocks; carried task defects affecting its result block regardless of origin.
For inherited findings set predatesTask true only with concrete evidence they predate the task;
otherwise set it false. On rejection provide remaining, diagnosis and revival for the repair.
Prior blocking findings and synthesis original: ${JSON.stringify(invocation.taskFrame.reviewRepair ?? null)}.
When repairing, review the whole slot delta and verify every prior blocking finding is closed.
Report conflict when expectedResult requires a spec exclusion. No unrelated improvements.
Finish with structured_output.`;
    return ["reviewer", "synthesis"].reduce((previous, stage) => previous.then(() => {
      const childKey = `${descriptor.key}.task-${stage}`;
      if (review[stage]) return;
      const prior = stage === "synthesis" ? review.reviewer : null;
      return analysisDispatch([{ key: childKey, agent: "pitako.reviewer", context: "fresh",
        cwd: config.root, label: `Task ${stage}: ${task.id}`, phase: `task-${stage}`,
        model: invocation[stage === "reviewer" ? "taskReviewer" : "taskSynthesis"],
        output: `${childKey}.json`, outputMode: "file-only", reads: false, progress: false,
        skill: ["verify-behavior", "scope-discipline"], outputSchema: taskReviewSchema,
        task: brief + (prior ? `\nStrict synthesis: read the reviewer original by path ${prior.path}
(canonical digest ${prior.digest}); re-check every finding against source and rescore independently.
Admit only if all three scores >=9 and no introduced or task-outcome finding blocks.` : ""),
      }]).then(([result]) => {
        if (!result?.ok || !result.structuredOutput) {
          const setting = `pitako.execute.${stage === "reviewer" ? "taskReviewer" : "taskSynthesis"}`;
          const model = invocation[stage === "reviewer" ? "taskReviewer" : "taskSynthesis"];
          const reason = `${setting} model '${model}' failed: ${result?.error ?? "missing original"}. Fix the setting and start a new invocation; no retry or fallback model.`;
          loop.halt = { status: "blocked", code: "task-review-model", reason,
            ref: nativeReference(childKey, result) };
          return save().then(() => { throw new Error(reason); });
        }
        const path = result.results?.find(item => text(item.savedOutputPath) && !item.outputSaveError)?.savedOutputPath;
        if (!path || !text(result.runId)) throw new Error("Task review original was not published.");
        const body = clone(result.structuredOutput);
        const reference = { key: childKey, runId: result.runId, path, digest: canonicalDigest(body) };
        review[stage] = { ...reference, projection: taskReviewProjection(body, reference, carried) };
        if (stage === "synthesis" && !review[stage].projection.admitted) {
          const verdict = review[stage].projection;
          const repair = invocation.taskFrame.reviewRepair;
          invocation.taskFrame.reviewRepair = { ...repair, source: reference, blocking: verdict.blocking,
            remaining: verdict.remaining ?? verdict.blocking, diagnosis: verdict.diagnosis ?? "",
            revival: verdict.revival ?? "",
            exhausted: !!repair?.attempt || verdict.conflict };
        }
        return save();
      });
    }), Promise.resolve());
  });
}
// Only the active root can turn the settled result and its saved gates into a seal.
function sealAndAdmit(result, descriptor, task, recoveryRef, statusRef) {
  if (loop.attempt.stage === "result") throw new Error("Duplicate attempt admission rejected.");
  let structural;
  try { structural = workerValue(result, descriptor, task, statusRef); } catch (error) {
    if (!error?.reportRejection) throw error;
    structural = { rejection: String(error.message) };
  }
  let groupedSeal;
  const complete = !structural.rejection && !recoveryRef && structural.value.status === "complete";
  return (complete ? verifyAttempt(descriptor, task, structural.value).then(receipt => {
    const passed = !receipt.mutated && (task.gates ?? task.checks).every(gate =>
      receipt.gates.some(result => result.id === gate.id && result.status === "pass"));
    return passed ? reviewTask(descriptor, task) : undefined;
  }).then(() => {
    // Ineligible attempts retain the grouped close, including its request observation.
    if (!descriptor.taskReview?.synthesis && !descriptor.taskReview?.unsettled && !descriptor.seal)
      return closeAttempt(descriptor, task, structural.value).then(receipt => { groupedSeal = receipt; });
    return observeMainRequests(0, [], true).then(() => {
      if (invocation.intentions?.length) return groupedIO("finishDrain", { operation: "drain" }, invocation);
    });
  }) : !structural.rejection && !recoveryRef && !descriptor.gate && !descriptor.seal
    ? closeAttempt(descriptor, task, structural.value).then(receipt => { groupedSeal = receipt; })
    : descriptor.close?.receipt?.projection
      ? closeAttempt(descriptor, task, structural.value).then(receipt => { groupedSeal = receipt; })
      : !structural.rejection && !recoveryRef ? verifyAttempt(loop.attempt, task, structural.value) : Promise.resolve()).then(() => {
  descriptor.gate = loop.attempt.gate;
  const receipt = descriptor.gate?.receipt;
  const definitions = task.gates ?? task.checks;
  const passed = receipt && !receipt.mutated && receipt.gates.length === definitions.length &&
    definitions.every(gate => receipt.gates.some(result => result.id === gate.id && result.status === "pass"));
  const admittedReview = descriptor.taskReview?.synthesis?.projection;
  const repair = invocation.taskFrame.reviewRepair;
  if (repair?.attempt && (structural.rejection || structural.value.status !== "complete" ||
      !passed || admittedReview?.admitted === false)) repair.exhausted = true;
  const kind = recoveryRef || structural.rejection ? null :
    structural.value.status === "complete" && passed && admittedReview?.admitted !== false ? "unit" : "pause";
  const pending = loop.attempt.seal ??= { retry: 0, kind };
  if (pending.kind !== kind) throw new Error("Saved seal kind differs from its gate receipt; recovery required.");
  const reusedSealer = descriptor.taskReview?.synthesis && settledTaskSealer?.key === sealerKey(descriptor.key, pending.retry - 1)
    ? settledTaskSealer : null;
  const retry = reusedSealer ? pending.retry - 1 : pending.retry;
  const sealKey = sealerKey(descriptor.key, retry);
  const intent = descriptor.checkpoint;
  if (!intent) throw new Error("Missing checkpoint intention for root observation.");
  let ref = groupedSeal ? clone(descriptor.close.ref) : { key: sealKey, agent: "pitako.checkpoint-sealer" };
  pending.retry = retry + 1;
  settledTaskSealer = null;
  return (groupedSeal ? save().then(() => null) : reusedSealer ? Promise.resolve([reusedSealer.result])
    : save().then(() => dispatch([{ key: sealKey, agent: "pitako.checkpoint-sealer",
    task: JSON.stringify({ v: 1, intent, kind,
      ...(descriptor.restore ? { restoreSources: descriptor.restore.sourceKeys.map(sourceKey => {
        const source = invocation.taskFrame.sources.find(item => item.key === sourceKey);
        if (!source) throw new Error("Missing authenticated restoration source intent.");
        return source;
      }) } : {}) }), cwd: config.root, context: "fresh", output: false, outputMode: "inline",
    outputSchema: false, reads: false, progress: false }]))).then(results => {
    const sealed = results?.[0];
    if (!groupedSeal) ref = { ...nativeReference(sealKey, sealed), agent: "pitako.checkpoint-sealer" };
    const cause = groupedSeal ? null : barrier(sealed, sealKey);
    if (cause) throw nativeBarrier(cause, ref);
    let observed = groupedSeal?.receipt;
    if (typeof sealed?.output === "string" && utf8Bytes(sealed.output) <= 61440) {
      try { observed = JSON.parse(sealed.output); } catch (_) { /* Invalid stdout is a barrier, not evidence. */ }
    }
    const failures = [sealed, ...(sealed?.results ?? [])].filter(Boolean);
    if (!groupedSeal && (!sealed?.ok || sealed.agent !== "pitako.checkpoint-sealer" || !text(sealed.runId) ||
        sealed.key !== undefined && sealed.key !== sealKey || sealed.state !== undefined || sealed.terminalOutcome ||
        !text(sealed.asyncDir) || !text(sealed.externalAdapter?.outputArtifacts?.stdoutPath) ||
        !text(sealed.externalAdapter?.outputArtifacts?.stderrPath) ||
        !Array.isArray(sealed.results) || sealed.results.length !== 1 || sealed.results[0].exitCode !== 0 ||
        failures.some(item => item.error || item.outputSaveError || item.metadataSaveError || item.transcriptError ||
          item.outputPartial || item.truncation || item.timedOut || item.processSignal ||
          item.exitCode !== undefined && item.exitCode !== 0)) ||
        !observed || observed.v !== 1 || observed.kind !== kind ||
        !["sealed", "observed", "mismatch", "open"].includes(observed.outcome))
      throw nativeBarrier("Checkpoint sealer lacks successful terminal stdout.", ref);
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
      const reason = `Checkpoint journal integrity conflict: ${observed.paths.map(entry =>
        `${entry.path}: journaled sha256 ${entry.journaled ?? "absence"}, actual sha256 ${entry.actual ?? "absence"}, last step partially applied: ${entry.partiallyApplied}`).join("; ")}.
Return the files to their journaled bytes and resume (the sealer retries under the next .rN), or start a new mission.`;
      loop.halt = { status: "blocked", code: "checkpoint-integrity", reason, ref };
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
    // This synchronous admission consumes only this dispatch's in-memory result.
    const admitted = admitWorker(result, descriptor, task, recoveryRef, statusRef, observed, structural.rejection ? structural : undefined);
    if (groupedSeal) {
      descriptor.close.receipt = receiptReference(descriptor.close.receipt);
      delete descriptor.close.input;
    }
    return save().then(() => admitted);
  }).catch(error => {
    if (error.spawnBudgetExhausted) { pending.retry = retry; throw error; }
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
function prepareSeal(projected) {
  invocation.sealPending = { expected: clone(invocation.ledger), record: { kind: "unit", loop: loop.number,
    body: archiveProjection({ taskId: projected.taskId, attempt: projected.attempt, result: clone(projected),
      // `result` is this attempt. An earlier result confirmed by its own seal is
      // already that unit record's result, so it is cited; an unsealed one is archived here.
      results: clone(loopResults().filter(item => item.taskId === projected.taskId && item.attempt !== projected.attempt)
        .map(item => item.checkpoint?.confirmation ? { taskId: item.taskId, attempt: item.attempt, status: item.status,
          sealed: { key: item.ref.key, digest: item.checkpoint.confirmation.digest } } : item)),
      frame: clone(invocation.taskFrame), recoveries: clone(loop.recoveries),
      checkpoint: clone(invocation.lastConfirmed) }) } };
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
function bodyIdentity(body) {
  const encoded = JSON.stringify(body);
  let hash = 2166136261;
  for (let index = 0; index < encoded.length; index++) hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619);
  return `${encoded.length}:${hash >>> 0}`; // Programming invariant, not ledger authentication.
}
function closingRecord() {
  const pending = loop.archivePending;
  const record = loopArchive(pending.frozen).record;
  if (bodyIdentity(record.body) !== pending.bodyIdentity)
    throw new Error("Closing archive source fields changed before publication.");
  return record;
}
// A pending loop archive keeps its identity and the inputs that may still change,
// not a second copy of the frozen loop; publication rebuilds identical bytes.
function frozenLoopArchive(freezeScope) {
  const pending = loopArchive();
  pending.bodyIdentity = bodyIdentity(pending.record.body);
  pending.frozen = { usage: clone(loop.usage), ...(loop.resolutions ? { resolutions: archiveProjection(loop.resolutions) } : {}),
    ...(freezeScope ? { cancelledScope: clone(cancelledScope()) } : {}) };
  delete pending.record.body;
  return pending;
}
function frozenLoopRecord(number, archive) {
  const record = loopArchive(archive.frozen).record;
  if (record.loop !== number || loop.archived || bodyIdentity(record.body) !== archive.bodyIdentity)
    throw new Error(`Loop ${number} archive source fields changed before publication; inspect the retained loop, no replacement record.`);
  return record;
}
function loopArchive(frozen) {
  const body = {};
  for (const field of ["number", "cursor", "manifest", "plan", "attempt", "results",
    "recoveries", "analysisCalls", "review", "compliance", "candidate", "resolutions", "usage"]) {
    const value = field === "results" ? loopResults()
      : frozen && ["usage", "resolutions"].includes(field) ? frozen[field] : loop[field];
    if (value !== undefined) body[field] = archiveProjection(value);
  }
  const scope = frozen?.cancelledScope ?? cancelledScope();
  if (scope.length) body.cancelledScope = clone(scope);
  return { expected: clone(invocation.ledger), record: { kind: "loop", loop: loop.number, body } };
}
function retainedResolutions() {
  return [...(invocation?.resolutions ?? []).slice().reverse(),
    ...(invocation?.lastClosedResolution ? [invocation.lastClosedResolution] : []),
    ...(loop?.resolutions ?? []).slice().reverse()];
}
function historyReference() {
  return { ledgerPath: `${config.root}/.pi/subagents/execute/${config.invocation}`, head: invocation.ledger.head };
}
function validSummaries(values) {
  return Array.isArray(values) && values.length > 0 && values.length <= 3 &&
    values.every((value, index) => value && Object.keys(value).sort().join(",") === "compliance,gaps,loop,rejection,review,status" &&
      Number.isSafeInteger(value.loop) && value.loop > 0 && value.loop <= loop.number &&
      (!index || values[index - 1].loop < value.loop) && ["complete", "gaps"].includes(value.status) &&
      ["gaps", "review", "compliance", "rejection"].every(field => typeof value[field] === "string" && value[field].length <= 1100)) &&
    values.at(-1).loop === loop.number;
}
function foldLoop(summaries) {
  const sources = [];
  const exit = loop.manifest && loop.cursor < loop.manifest.length ? loopResults().at(-1) : null;
  if (exit?.ok && ["gaps", "continue"].includes(exit.status))
    sources.push({ kind: "worker", ref: exit.ref, taskId: exit.taskId, attempt: exit.attempt,
      status: exit.status, diagnosis: excerpt(exit.diagnosis) });
  if (loop.review?.verdict === "material-gaps")
    sources.push({ kind: "review", ref: loop.reviewSynthesis, reason: excerpt(loop.review.reason) });
  if (loop.compliance?.status === "gaps")
    sources.push({ kind: "compliance", ref: loop.compliance.ref, reason: excerpt(loop.compliance.reason) });
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
  const disposition = loop.resolutions?.at(-1);
  invocation.lastClosedResolution = disposition ? Object.fromEntries(
    ["request", "stage", "loop", "text", "currentBarrier", "hostHalt", "failedHostObservation"]
      .filter(field => disposition[field] !== undefined).map(field => [field, clone(disposition[field])])) : null;
  foldUsage();
  delete loop.analysisCalls;
  loop.recoveries = [];
}
function archiveGaps() {
  if (loop.archived || loop.archiveQueued) return Promise.resolve();
  const pending = loop.archivePending ??= frozenLoopArchive(true);
  // Safety margin, decided once: when the frozen loop and pending seal bodies leave
  // too little native headroom, publish those seals before queueing the loop archive.
  pending.drainFirst ??= !!invocation.intentions?.length && stateBytes() > DRAIN_BEFORE_ARCHIVE_BYTES;
  return (pending.drainFirst && invocation.intentions?.length
    ? groupedIO("finishDrain", { operation: "drain" }, invocation) : Promise.resolve()).then(() => {
    // A drain moved the anchor after this archive was frozen; the anchor is not body content.
    if (!invocation.intentions?.some(entry => entry.operation === "ledger")) pending.expected = clone(invocation.ledger);
    return archiveSeal(pending);
  });
}
function archiveSeal(pending = invocation.sealPending) {
  // Retained legacy publications still use their original recovery route.
  if (pending.retry) return legacyArchiveSeal(pending);
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
    loop.results = loop.results.filter(entry => !entry.ref ||
      same(invocation.tasks[entry.taskId]?.last, entry) || same(entry.ref, invocation.lastConfirmed.resultRef));
    const cited = JSON.stringify(loop.resolutions ?? []);
    loop.recoveries = loop.recoveries.filter(item => cited.includes(item.ref.key));
    if (pending.record.body.result.status === "complete") {
      invocation.taskFrame = null;
      delete loop.interruptions;
      delete loop.attempt.pauseSource;
      delete loop.attempt.restore;
    }
  }
  return save();
}
function legacyArchiveSeal(pending = invocation.sealPending) {
  const closingGap = pending.record.kind === "loop";
  let tries = 0;
  function publish() {
    tries++;
    const retry = pending.retry ?? 0;
    const sealKey = `${key}.l${pending.record.loop}.${closingGap ? "gaps" : `seal${Math.max(1, pending.expected.count)}`}${retry ? `.r${retry}` : ""}`;
    return Promise.resolve().then(() => {
      if (config.preliminary.digest !== invocation.association.digest)
        throw Object.assign(new Error("Spec digest mismatch requires reliable admitted source bytes."), { ledgerIntegrity: true });
      pending.retry = retry + 1;
      return save();
    }).then(() => dispatch([{ key: sealKey, agent: "pitako.execution-ledger",
      task: JSON.stringify({ invocation: config.invocation, expected: pending.expected, record: pending.record,
        ...(pending.expected.count === 0 ? { spec: { content: config.preliminary.content, digest: invocation.association.digest } } : {}) }),
      cwd: config.root, context: "fresh", output: false, outputMode: "inline", outputSchema: false,
      reads: false, progress: false }])).then(results => {
      const result = results[0];
      if (result?.nativeFailure) throw Object.assign(new Error(result.nativeFailure.reason), { nativeFailure: result.nativeFailure });
      const cause = barrier(result, sealKey);
      if (cause) throw nativeBarrier(cause, nativeReference(sealKey, result));
      let anchor;
      if (typeof result?.output === "string" && utf8Bytes(result.output) <= 61440) {
        try { anchor = JSON.parse(result.output); } catch (_) { /* Retry exact bytes through the ledger. */ }
      }
      if (result?.agent === "pitako.execution-ledger" && anchor &&
          Object.keys(anchor).sort().join(",") === "error,reason" &&
          anchor.error === "ledger-integrity" && text(anchor.reason))
        throw Object.assign(new Error(`Ledger integrity requires human reconciliation: ${anchor.reason}`), { ledgerIntegrity: true });
      const failures = [result, ...(result?.results ?? [])].filter(Boolean);
      if (!result?.ok || result.agent !== "pitako.execution-ledger" || !text(result.runId) ||
          result.key !== undefined && result.key !== sealKey || result.state !== undefined || result.terminalOutcome ||
          !text(result.asyncDir) || !text(result.externalAdapter?.outputArtifacts?.stdoutPath) ||
          !text(result.externalAdapter?.outputArtifacts?.stderrPath) ||
          !Array.isArray(result.results) || result.results.length !== 1 || result.results[0].exitCode !== 0 ||
          failures.some(item => item.error || item.outputSaveError || item.metadataSaveError || item.transcriptError ||
            item.outputPartial || item.truncation || item.timedOut || item.processSignal ||
            item.exitCode !== undefined && item.exitCode !== 0) ||
          !anchor || Object.keys(anchor).sort().join(",") !== (closingGap ? "count,head,summaries" : "count,head") ||
          closingGap && !validSummaries(anchor.summaries) ||
          anchor.count !== Math.max(1, pending.expected.count) + 1 || !/^[a-f0-9]{64}$/.test(anchor.head ?? ""))
        throw new Error("Ledger publication lacks valid successful terminal stdout/anchor.");
      const before = { ledger: invocation.ledger, frame: invocation.taskFrame, results: loop.results,
        recoveries: loop.recoveries, interruptions: loop.interruptions, attempt: clone(loop.attempt) };
      invocation.ledger = { count: anchor.count, head: anchor.head };
      if (closingGap) {
        const beforeLoop = clone(loop), beforeTotals = clone(invocation.usageTotals);
        loop.archived = true;
        delete loop.archivePending;
        foldLoop(anchor.summaries);
        return save().then(() => {
          persistenceFailed = false; persistenceReason = null;
        }, error => {
          Object.keys(loop).forEach(name => delete loop[name]); Object.assign(loop, beforeLoop);
          loop.archivePending = pending;
          invocation.usageTotals = beforeTotals; invocation.ledger = before.ledger;
          throw error;
        });
      }
      loop.results = loop.results.filter(entry => !entry.ref ||
        same(invocation.tasks[entry.taskId]?.last, entry) || same(entry.ref, invocation.lastConfirmed.resultRef));
      const cited = JSON.stringify(loop.resolutions ?? []);
      loop.recoveries = loop.recoveries.filter(item => cited.includes(item.ref.key));
      if (pending.record.body.result.status === "complete") {
        invocation.taskFrame = null;
        delete loop.interruptions;
        delete loop.attempt.pauseSource;
        delete loop.attempt.restore;
      }
      invocation.sealPending = null;
      return save().then(() => {
        persistenceFailed = false; persistenceReason = null;
      }, error => {
        invocation.ledger = before.ledger; invocation.taskFrame = before.frame;
        loop.results = before.results; loop.recoveries = before.recoveries;
        loop.interruptions = before.interruptions; loop.attempt = before.attempt;
        invocation.sealPending = pending;
        throw error;
      });
    }).catch(error => {
      if (error.spawnBudgetExhausted) {
        pending.retry = retry;
        throw error;
      }
      if (error.terminalPersistence) throw error;
      if (!error.ledgerIntegrity && !error.nativeBarrier && error.nativeFailure?.code !== "capacity" && tries < 3) {
        persistenceFailed = false; persistenceReason = null;
        return publish();
      }
      if (error.nativeBarrier) {
        loop.halt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
          code: "native-barrier", cause: error.nativeBarrier, reason: String(error.message),
          ref: clone(error.nativeReference ?? { key: sealKey, agent: "pitako.execution-ledger" }) };
        return save().then(() => { throw error; }, saveError => { error.message += ` ${saveError.message}`; throw error; });
      }
      if (error.nativeFailure?.code === "capacity") throw error;
      persistenceFailed = true;
      persistenceReason = `Essential persistence failed; ${closingGap ? "loop" : "seal"} publication pending: ${error.ledgerIntegrity
        ? error.message : `three publication attempts failed (${String(error?.message ?? error)}); repeated failure requires operator repair`}`;
      throw new Error(persistenceReason);
    });
  }
  return publish();
}
function validLoopAnchor(anchor) {
  return anchor && Object.keys(anchor).sort().join(",") === "count,head" &&
    anchor.count === Math.max(1, loop.archivePending.expected.count) + 1 && /^[a-f0-9]{64}$/.test(anchor.head ?? "");
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
function writeFreeWorkerBlock() {
  const attempt = loop?.attempt, result = attempt?.stage === "result" && attempt.result;
  return loop?.phase === "implementation" && result?.status === "blocked" && result.remainingCount > 0 &&
    loop.halt?.code === "semantic-block" && same(loop.halt.ref, result.ref) && !attempt.restore &&
    !attempt.capturedPaths && !result.checkpoint?.confirmation;
}
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
    operation: "edit the backlog or deliver an amendment, then relaunch or unblock through the existing routes", reason, references: [], started: false };
  if (loop?.halt?.code === "spawn-budget") return { actor: "human",
    operation: "raise config.maxSubagentSpawnsPerRun or reduce the step's spawn demand", reason, references: [], started: false };
  const required = status !== "complete";
  const exhausted = !persistenceFailed && !loop?.halt && status === "partial" &&
    invocation?.consumedLoops >= maxCycles();
  return {
    actor: !required ? "none" : persistenceFailed ? "persistence operator" : exhausted ? "human"
      : hostHalt ? "native run operator"
      : loop?.halt?.code === "recovery" ? "evidence owner"
      : loop?.halt?.code === "semantic-block" ? "task owner"
      : loop?.halt ? "native run operator" : "active root",
    operation: !required ? "close" : persistenceFailed ? "restore essential persistence; no dispatch authorized"
      : hostHalt ? "reconcile the retained host observation through bounded read-only reconstruction under native policy; observed barriers still govern effects"
      : exhausted ? "authorize a new invocation"
      : loop?.halt ? "resolve the concrete retained impediment; no replacement dispatch"
      : "perform the next existing phase under native authority",
    reason, references: [hostHalt?.ref, resolution?.currentBarrier?.ref, loop?.halt?.ref, loop?.recoveries?.at(-1)?.ref,
      loop?.observation?.ref, loop?.attempt?.launch, loop?.plan?.ref, ...(loop?.analysisCalls ?? []).map(call => call.ref)].filter(Boolean),
    // This describes pending work, not a claim that a root was resumed.
    started: false,
  };
}
function canSaveBudgetExhaustion(error) {
  return error?.spawnBudgetExhausted && invocation?.association && !persistenceFailed && !loop?.halt &&
    !resolution?.currentBarrier && !hostHalt;
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
  const stalled = same(marker, invocation.lastBudgetProgress);
  invocation.lastBudgetProgress = marker;
  if (stalled) loop.halt = { status: "blocked", code: "spawn-budget",
    reason: "No seals admitted or loops closed since the previous budget-exhausted end; one step needs more spawns than the per-run budget. Human intervention must raise config.maxSubagentSpawnsPerRun or reduce that step's spawn demand." };
  return save().then(() => finish(stalled ? "blocked" : "budget-exhausted", stalled ? loop.halt.reason :
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
      if (canSaveBudgetExhaustion(error))
        return finishBudgetExhaustion().catch(saveError => finish("partial", `${error.message}; ${saveError.message}`, true));
      if (error.nativeBarrier) loop.halt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
        code: "native-barrier", cause: error.nativeBarrier, reason: String(error.message),
        ...(error.nativeReference ? { ref: clone(error.nativeReference) } : {}) };
      const halted = loop?.halt?.status ?? (status === "partial" ? "partial" : "blocked");
      return (error.nativeBarrier ? save() : Promise.resolve())
        .then(() => finish(halted, String(error.message), true),
          saveError => finish(halted, `${error.message}; ${saveError.message}`, true));
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
try {
  if ((config.unblock !== undefined || config.resolution !== undefined) &&
      (config.unblock !== true || !config.resolution ||
        Object.keys(config.resolution).sort().join(",") !== "loop,text" ||
        !Number.isSafeInteger(config.resolution.loop) || config.resolution.loop < 0 ||
        !text(config.resolution.text) || config.resolution.text.includes("\0")))
    return finish("blocked", "--unblock requires current human resolution: {loop, text}.");
  if (!text(config.missionId) || !text(config.missionPath) || !text(config.invocation))
    return finish("blocked", "Existing native missionId and actually returned missionPath are required.");
  invocation = await state.get(key);
  // Incompatible retained state fails before any resume or dispatch.
  if (!Number.isSafeInteger(config.stateVersion)) return finish("blocked", "Missing resolved execute state contract version.");
  if (invocation && invocation.version !== config.stateVersion)
    return finish("blocked", `Retained execution created by an incompatible Pitako contract v${invocation.version}; start a new mission. No migration or replay is supported; retained unchanged.`);
  activePlan = invocation?.activePlan;
  loop = invocation?.loop;
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
  if (invocation?.hostHalt) {
    hostHalt = invocation.hostHalt;
    if (!same(hostHalt.request, hostRequest()))
      return finish("blocked", "Retained host observation belongs to a different immutable request; retained unchanged.");
  }
  const legacy = await state.get("pitako-execution");
  if (legacy && legacy.version !== config.stateVersion)
    return finish("blocked", `Retained execution created by an incompatible Pitako contract v${legacy.version}; start a new mission. No migration or replay is supported; retained unchanged.`);
  if (legacy && (legacy.version !== invocation?.version || !same(legacy.association, invocation?.association) ||
      legacy.association.invocation !== config.invocation))
    return finish("blocked", "Native mission already belongs to another immutable invocation; no replacement writer dispatched.");
  if (!config.unblock && loop?.halt?.code === "repeat-acceptance")
    return finish(loop.halt.status, loop.halt.reason);
  if (!config.unblock && invocation?.lastBudgetProgress) {
    if (loop?.halt) return finish(loop.halt.status, loop.halt.reason);
    const blockedResolution = retainedResolutions().find(item => item.currentBarrier);
    if (blockedResolution) return finish(["stopped", "interrupted"].includes(blockedResolution.currentBarrier.cause) ? "cancelled" : "blocked",
      `Current continuation encountered a native barrier: ${blockedResolution.currentBarrier.cause}; this input does not authorize another interruption.`);
    const resolvedHost = hostHalt && !["queued", "running", "pending"].includes(hostHalt.observedState) &&
      (invocation.hostReconstruction?.stage === "admitted" && same(invocation.hostReconstruction.source, hostHalt) &&
          !hostHalt.observedBarrier && hostHalt.status !== "cancelled" && !["stopped", "interrupted"].includes(hostHalt.observedState) ||
        retainedResolutions().some(item => ["accepted", "applied"].includes(item.stage) &&
          !item.failedHostObservation && same(item.hostHalt, hostHalt)));
    if (hostHalt && !resolvedHost) return finish(hostHalt.status, hostHalt.reason);
  }
  const sealBarrier = invocation?.sealPending && loop?.halt?.code === "native-barrier" &&
    ["stopped", "interrupted", "native permission denial"].includes(loop.halt.cause);
  if (sealBarrier && !config.unblock) return finish(loop.halt.status, loop.halt.reason);
  if (invocation?.sealPending && !sealBarrier) await archiveSeal();
  if (!config.unblock) {
    // A durable human input survives technical replay without another flag.
    // Matching its original observation does not settle subsequent intentions.
    const retained = retainedResolutions();
    if (retained.some(item => !same(item.request, hostRequest())))
      return finish("blocked", "Retained continuation input association conflicts; retained unchanged.");
    // Keep the latest disposition, including a later native barrier. Falling
    // back to an older successful input could otherwise revive its authority.
    resolution = retained.find(item => same(item.request, hostRequest()));
  }
  if (config.unblock) {
    const existing = retainedResolutions().find(item => item.text === config.resolution.text && item.loop === config.resolution.loop);
    const target = config.resolution.loop === 0 ? invocation : loop?.number === config.resolution.loop && !loop.archived ? loop : null;
    if ((!target && !existing) || (!existing && (config.resolution.loop !== (loop?.number ?? 0) ||
        !(hostHalt || loop?.halt || loop?.outcome === "blocked" || loop?.outcome === "cancelled"))))
      return finish("blocked", "Current resolution must name the retained interrupted loop/request, not a new invocation or an unrelated loop.");
    resolution = existing;
    if (!resolution) {
      resolution = { ...clone(config.resolution), request: hostRequest(), stage: "intention",
        ...(loop?.halt ? { halt: clone(loop.halt) } : {}),
        ...(hostHalt ? { hostHalt: clone(hostHalt) } : {}),
        operations: [
          ...(loop?.phase === "director" && loop.plan ? [clone(loop.plan.ref)] : []),
          ...(loop?.attempt && (!loop.attempt.result || confirmedPausePending()) ? [clone(loop.attempt.launch ?? { key: loop.attempt.key })] : []),
          ...(loop?.analysisCalls ?? []).map(call => clone(call.ref)),
        ] };
      (target.resolutions ??= []).push(resolution);
      // Retain the actual input and original impediment before any observation.
      await save();
    }
  }
  if (resolution) {
    if (!same(resolution.request, hostRequest()) || !["intention", "accepted", "applied"].includes(resolution.stage) ||
        !Number.isSafeInteger(resolution.loop) || !text(resolution.text))
      return finish("blocked", "Current resolution request association conflicts; retained unchanged.");
    if (resolution.failedHostObservation) {
      if (!hostHalt || !same(resolution.failedHostObservation, hostHalt))
        return finish("blocked", "Later host observation conflicts with the retained continuation; retained unchanged.");
      if (hostHalt.observedBarrier || hostHalt.status === "cancelled" ||
          ["queued", "running", "pending", "stopped", "interrupted"].includes(hostHalt.observedState))
        return finish("blocked", "This continuation encountered a native host barrier; new useful current input is required.");
      // The old answer has no authority over this new operation. An unknown
      // transport failure instead takes the same bounded pure reconstruction
      // route as one without a human answer; retain both original observations.
      resolution = undefined;
    }
    if (resolution && hostHalt && same(resolution.hostHalt, hostHalt)) {
      if (["queued", "running", "pending"].includes(hostHalt.observedState))
        return finish("blocked", "Retained host observation is positively pending; no replacement inspection.");
      hostHalt = undefined;
    }
  }
  if (hostHalt && !resolution) {
    // A transport exception is not Stop or permission evidence. Reconstruct
    // read-only state once, durably, without demanding redundant human input.
    // This does not settle any retained writer, inspector or model intention.
    if (hostHalt.observedBarrier || hostHalt.status === "cancelled" ||
        ["queued", "running", "pending", "stopped", "interrupted"].includes(hostHalt.observedState))
      return finish(hostHalt.status, `${hostHalt.reason} Retained native barrier requires reconciliation or current continuation input.`);
    hostReconstruction = invocation.hostReconstruction;
    if (hostReconstruction && (!same(hostReconstruction.source, hostHalt) || !["intention", "admitted"].includes(hostReconstruction.stage)))
      return finish("blocked", `Bounded host reconstruction is unresolved or failed; retain the exact operation, no replacement inspection authorized. ${hostReconstruction.failure?.reason ?? ""}`);
    // A committed intention has no admitted observation yet. Only the fixed
    // pure inspection/capture projections below may repeat: this is neither
    // reattachment nor evidence that an earlier host call or writer settled.
    // Pending model queries and modifying operations keep their own barriers.
    if (!hostReconstruction) {
      hostReconstruction = invocation.hostReconstruction = { source: clone(hostHalt), stage: "intention" };
      await save();
    }
    hostHalt = undefined;
  }
  if (hostHalt) return finish("blocked", hostHalt.reason);
  const current = await host(config.inspections[0]);
  if (text(current.error)) throw new Error([current.error, current.next].filter(Boolean).join(" "));
  const captured = capture(current);
  let metadata = captured.metadata;
  if (!invocation?.association) {
    const requestState = invocation;
    const admitted = current.admission ?? {};
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
      planRejections: [], closeReferences: [], loopSummaries: [], lastClosedResolution: null, activePlan: null,
      ...(requestState?.hostHalt ? { hostHalt: requestState.hostHalt } : {}),
      ...(requestState?.resolutions ? { resolutions: requestState.resolutions } : {}),
      ...(requestState?.hostReconstruction ? { hostReconstruction: requestState.hostReconstruction } : {}),
    };
    if (metadata.root !== config.root) throw new Error("Designated worktree mismatch.");
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
  if (!legacy) {
    try { await persistState("pitako-execution", { version: invocation.version, association: invocation.association }); }
    catch (error) { persistenceFailed = true; throw new Error(`Essential persistence failed; dispatch halted: ${String(error)}`); }
  }
  if (hostReconstruction?.stage === "intention") {
    hostReconstruction.observation = {
      ref: clone(references.filter(ref => ref.key === config.inspections[0].key).at(-1) ?? { key: config.inspections[0].key }),
      candidate: candidate(current.checkout), source: metadata.selected.source, digest: metadata.selected.digest,
    };
    hostReconstruction.stage = "admitted";
    await save();
  }
  inspectedAnalyses = metadata.retainedAnalyses ?? [];
  checkpointObservation = metadata.checkpointObservation;
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
  if (resolution?.currentBarrier)
    return finish(["stopped", "interrupted"].includes(resolution.currentBarrier.cause) ? "cancelled" : "blocked",
      `Current continuation encountered a native barrier: ${resolution.currentBarrier.cause}; this input does not authorize another interruption.`);
  if (resolution && resolution.loop !== loop?.number && loop?.halt?.code === "native-barrier" &&
      ["stopped", "interrupted", "native permission denial"].includes(loop.halt.cause))
    return finish(loop.halt.status, loop.halt.reason);
  if (resolution?.stage === "intention") {
    resolution.stage = "accepted";
    await save();
  }
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && !loop.archived && !confirmedPausePending())
    await reconcileRetainedRecoveries();
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && !loop.archived &&
      loop.halt?.code === "native-barrier" && (!confirmedPausePending() ||
        invocation.sealPending && loop.halt.ref?.agent === "pitako.execution-ledger" ||
        loop.halt.ref?.agent === "pitako.loop-io") &&
      ["stopped", "interrupted", "native permission denial"].includes(loop.halt.cause))
    await reconcileInterruptedOperations();
  if (invocation.sealPending && !loop?.halt) await archiveSeal();
  // A cut after accepting input must still drain that exact queue before restoration.
  if (["accepted", "applied"].includes(resolution?.stage) && !loop?.halt) {
    for (const owner of [invocation, loop, loop?.attempt ?? {}]) {
      for (const [slot, pending] of Object.entries(owner ?? {})) {
        if (pending?.input?.operation === "drain" && !pending.admitted && text(pending.reconciled) &&
            pending.reconciled === resolution.halt?.ref?.key)
          await groupedIO(slot, pending.input, owner);
      }
    }
  }
  if (resolution?.stage === "accepted" && (resolution.loop === 0 || resolution.loop === loop?.number && !loop.archived) && resolution.hostHalt && !loop?.halt) {
    // The bounded reconstruction is applied, not a claim that a historical
    // host receipt or a later writer has settled.
    resolution.stage = "applied";
    await save();
  }
  // Only an admitted cooperative pause with pending work consumes current input.
  // A checkpoint alone does not resolve an unrelated semantic/product impediment.
  const paused = loop?.attempt?.stage === "result" && loop.attempt.result;
  const resolvedSealPause = !invocation.sealPending && !loop?.halt &&
    ["pitako.execution-ledger", "pitako.loop-io"].includes(resolution?.halt?.ref?.agent) && resolution.observations?.length;
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && !loop.archived && confirmedPausePending() &&
      (resolvedSealPause || same(resolution.halt, loop.halt) && (loop.halt?.code === "semantic-block" ||
        (loop.halt?.code === "native-barrier" && ["stopped", "interrupted"].includes(loop.halt.cause))))) {
    const ref = loop.attempt.launch ?? paused.ref;
    resolution.stage = "applied";
    let observed;
    try {
      observed = await observeStatus(ref.runId ?? ref.key, true);
      assertFallbackProducer(observed, ref);
    } catch (error) {
      if (error.nativeBarrier) {
        resolution.currentBarrier = { cause: error.nativeBarrier, ref: clone(ref) };
        loop.halt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked",
          code: "native-barrier", cause: error.nativeBarrier, reason: String(error.message), ref: clone(ref) };
      }
      throw error;
    }
    delete loop.halt;
    delete loop.outcome;
    // Admission and the exact restoration intention share one essential save.
    await checkpointFallback(observed, ref, { id: paused.taskId });
  }
  // A write-free worker block has no pause to restore. Current input answering
  // that exact block continues the same task in this loop with a fresh attempt.
  // Restoring attempts are excluded: their capturedPaths counts only their own
  // journal, and a blocked restorer may hold unreceipted restored bytes.
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && !loop.archived &&
      writeFreeWorkerBlock() && same(resolution.halt, loop.halt)) {
    resolution.stage = "applied";
    loop.attempt.humanContinuation = { loop: resolution.loop, halt: clone(resolution.halt) };
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  // Recover the old result-committed/outcome-not-committed cut before plan recovery.
  if (loop?.attempt?.stage === "result" && loop.attempt.result?.status === "blocked" &&
      !loop.attempt.humanContinuation && (!loop.halt || loop.halt.code === "semantic-block"))
    retainWorkerBlock(loop.attempt.result);
  // Historical read-only parser rejection is re-evaluated from exact originals,
  // not a new authorization or an extra implementation slot.
  if (loop?.halt?.code === "semantic-block" && ["review", "compliance"].includes(loop.phase)) {
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  // After the human returns the files to their journaled bytes, current input
  // clears the integrity halt; replay re-seals under the next sealer key.
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && !loop.archived &&
      loop.halt?.code === "checkpoint-integrity" && same(resolution.halt, loop.halt)) {
    resolution.stage = "applied";
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  if (loop?.halt?.code === "needs-decision") {
    if (resolution?.stage !== "accepted" || resolution.loop !== loop.number || !same(resolution.halt, loop.halt))
      return finish(loop.halt.status, loop.halt.reason);
    resolution.stage = "applied";
    delete loop.halt; loop.outcome = "gaps"; loop.endedAt = Date.now();
    invocation.currentView = null; activePlan = null;
    await save();
  }
  if (loop?.halt?.code === "repeat-acceptance") {
    if (resolution?.stage !== "accepted" || resolution.loop !== loop.number || !same(resolution.halt, loop.halt))
      return finish(loop.halt.status, loop.halt.reason);
    resolution.stage = "applied";
    delete loop.halt; loop.outcome = "gaps"; loop.endedAt = Date.now();
    invocation.currentView = null; activePlan = null;
    invocation.freshAcceptanceAuthorized = true;
    await save();
  }
  if (["capacity", "native-dispatch", "semantic-block", "checkpoint-integrity", "task-review-model"].includes(loop?.halt?.code))
    return finish(loop.halt.status, loop.halt.reason);
  // A prior barrier is not a historical universal hold. Recovery re-observes the
  // exact writer or analysis producer before any further external dispatch.
  // A completed verdict is reusable only for the same closing candidate.
  if (loop?.outcome === "complete" && same(loop.closing?.candidate, currentCandidate))
    return finish("complete", "Whole-spec fulfillment, mandatory checks and review remain bound to this candidate. No more loops required.");
  if (loop?.outcome === "complete") {
    loop.outcome = "gaps";
    loop.invalidated = "candidate-changed";
    await save();
  }
  if (loop?.halt?.code === "native-barrier" &&
      !["stopped", "native permission denial"].includes(loop.halt.cause) && loop.attempt && !loop.attempt.result) {
    // Re-observe retained activity, not an automatic effect. Historical activity
    // is not a recorded user Stop or proof that its successor is still pending.
    loop.attempt.interruption ??= clone(loop.halt);
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  if (!["review", "compliance"].includes(loop?.phase) && loop?.halt?.code === "native-barrier" &&
      ["stopped", "native permission denial"].includes(loop.halt.cause))
    return finish(loop.halt.status, loop.halt.reason);
  if (loop?.outcome === "blocked" || loop?.outcome === "cancelled")
    return finish(loop.outcome, "Retained native/decision impediment requires explicit resolution; slots are not renewed.");
  if (loop?.halt?.code === "backlog-conflict") {
    loop.plan.rejection = { diagnostic: loop.halt.reason, ref: clone(loop.plan.ref) };
    delete loop.halt; loop.outcome = "gaps"; loop.endedAt = Date.now();
    invocation.currentView = null; activePlan = null;
    await save();
  }
  // A technical halt raised before any director plan or writer names no retained
  // producer: replay re-runs the same retained pre-director intention, which
  // re-halts if its cause persists. Discharge it durably before that dispatch so
  // no later writer launches under a stale halt the checkpoint hook refuses.
  if (loop?.halt?.code === "recovery" && loop.phase === "director" && !loop.plan && !loop.attempt && !loop.archived) {
    if (resolution?.stage === "accepted" && resolution.loop === loop.number && same(resolution.halt, loop.halt))
      resolution.stage = "applied";
    delete loop.halt;
    await save();
  }
  while (true) {
    if (loop?.outcome === "gaps" && !loop.archived) await archiveGaps();
    if (loop?.outcome && invocation.intentions?.length && invocation.consumedLoops < maxCycles()) {
      await advanceLoop("nextAdvance", loop.number + 1);
      if (loop.halt) return finish(loop.halt.status, loop.halt.reason);
    }
    if (!loop || loop.outcome) {
      if (invocation.consumedLoops >= maxCycles()) return finish("partial", `${maxCycles()} authorized loops consumed; remaining work requires new human authorization.`);

      activePlan = null;
      const prepared = invocation.currentView && (invocation.preparedNext ?? loop?.prepare);
      loop = { ...(prepared ? { prepare: clone(prepared) } : {}), number: invocation.consumedLoops + 1, startedAt: Date.now(), phase: "director",
        cursor: 0, manifest: null, plan: null, attempt: null, results: [], recoveries: [], usage: [] };
      invocation.loop = loop;
      delete invocation.preparedNext;
      invocation.consumedLoops++;
      resolution = undefined;
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
      if (!loop.plan || budgetRejected(directorKey)) {
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
CURRENT BOARD VIEW: ${JSON.stringify(invocation.currentView)}
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
The human edits the backlog or delivers an amendment, then relaunches or unblocks through existing routes.
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
        if (barrier(result)) throw nativeBarrier(barrier(result));
        // Publication and admission are separate durable cuts.
        await save();
        if (!result?.ok && !text(result?.runId))
          throw new Error("Director failed without an authoritative settled producer reference.");
        activePlan = result?.structuredOutput;
        if (!activePlan && !(await recoverPlan()))
          throw new Error("No authoritative complete new backlog selection survives.");
        planAuthority(activePlan, result?.structuredOutput ? result : undefined);
        // Some boundaries return complete binding content as output; never parse
        // file-only previews or use them as an alternate task definition.
        if (text(result.output) && /^[\s]*\{/.test(result.output)) {
          let binding;
          try { binding = JSON.parse(result.output); } catch (_) { planConflict("Invalid complete backlog selection binding JSON."); }
          if (!same(binding, activePlan)) planConflict("Changed/conflicting backlog selection binding.");
        }
      } else if (!loop.task || replay) {
        replay = false;
        if (!await recoverPlan()) {
          if (loop.plan.ok === false) throw new Error("No authoritative complete new backlog selection survives.");
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          loopReport("gaps", "Original complete backlog selection lost; no task reconstructed from IDs.");
          continue;
        }
      }
      planAuthority(activePlan);
      validatePlan(activePlan);
      let applied;
      try {
        if (loop.selection?.stage === "receipt") assertSelection();
        if (text(activePlan.select)) loop.initialCheckpoint ??= checkpointIntent(activePlan.select, 1, `${key}.l${loop.number}.t1.a1`);
        await save();
        const transport = await groupedIO(`selectionIO${loop.directorRetry ? ".d1" : ""}`, { operation: "selection",
          apply: { root: config.root, specId: config.id, expectedDigest: invocation.backlogDigest,
            key: `${key}.l${loop.number}.selection${loop.directorRetry ? ".d1" : ""}`,
            invocation: config.invocation, loop: loop.number, authority: backlogAuthority(), director: activePlan },
          ...(loop.initialCheckpoint ? { baseline: loop.initialCheckpoint } : {}) });
        applied = groupedStep(transport, "apply");
        const { selected, completedTasks, ...receipt } = applied;
        loop.task = selected; loop.taskBacklogDigest = applied.digest;
        loop.selection = { stage: "receipt", receipt: { ...receipt, selected: selected?.id ?? null,
          ...(!selected ? { completedTasks } : {}), groupedReference: receiptReference(transport) } };
        await save();
        if (loop.initialCheckpoint) loop.selectionBaseline = groupedStep(transport, "baseline");
        loop.selectionRequests = { reference: receiptReference(transport), page: groupedStep(transport, "requests") };
      } catch (error) {
        const diagnostic = String(error?.message ?? error);
        if (!error.selectionRejected || error.backlogConflict) throw error;
        if (!loop.directorRetry && !error.replayRejected) {
          loop.directorRetry = { diagnostic: diagnostic.slice(0, 2000), rejectedRef: clone(loop.plan.ref) };
          loop.plan = null; delete loop.selection; delete loop.initialCheckpoint; activePlan = null;
          await save(); continue;
        }
        loop.plan.stage = "rejected"; loop.plan.rejection = { diagnostic, ref: clone(loop.plan.ref),
          ...(loop.directorRetry ? { previous: clone(loop.directorRetry) } : {}) };
        loop.outcome = "gaps"; loop.endedAt = Date.now(); activePlan = null; invocation.currentView = null;
        await save(); loopReport("gaps", diagnostic); continue;
      }
      invocation.backlogDigest = applied.digest;
      invocation.excludedScope = Object.fromEntries((applied.cancelledScope ?? []).map(task => [task.id, task]));
      invocation.currentView = applied.view; invocation.boardTopicId = applied.view.topicId;
      loop.kind = applied.selected ? "task" : "final";
      loop.task = applied.selected;
      if (loop.kind === "final") {
        // One retained copy: the selection receipt's copy only bridges this admission.
        loop.acceptance = applied.acceptance; loop.completedTasks = applied.completedTasks;
        delete loop.selection.receipt.completedTasks;
      }
      loop.metricSeries = clone(applied.selected?.progress ?? { nonImproving: 0, last5: [] });
      loop.manifest = applied.selected ? [applied.selected.id] : [];
      invocation.tasks = Object.fromEntries(loop.manifest.map(id => [id, { admitted: [], completed: null, last: null }]));
      loop.plan.association = association(loop.number); loop.plan.stage = "admitted";
      loop.phase = "implementation";
      // Full views remain replayable until this selection-admission save.
      for (const slot of ["prepare", "selection"]) {
        const receipt = loop[slot]?.receipt;
        if (receipt?.view) receipt.view = { topicId: receipt.view.topicId,
          viewDigest: receipt.viewDigest, viewBytes: receipt.viewBytes };
      }
      activePlan = null;
      await save();
      await observeGroupedRequests(loop.selectionRequests.reference, false, loop.selectionRequests.page);
      delete loop.selectionRequests;
      if (loop.initialCheckpoint) loop.initialCheckpoint = admitBaseline(loop.initialCheckpoint, loop.selectionBaseline);
      delete loop.selectionBaseline;
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
      if (loop.kind === "task" && !loop.task || replay) {
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
          const human = !!loop.attempt.humanContinuation;
          if (previous.status === "blocked" && !human) return finish("blocked", loop.halt.reason);
          if (previous.status === "complete") {
            await settleTask();
            loop.cursor++; loop.attempt = null; invocation.taskFrame = null; await save(); continue;
          }
          if (!previous.usefulContinuation && !human) break;
          let pauseSource = confirmedPausePending() ? { checkpoint: clone(loop.attempt.checkpoint),
            confirmation: clone(previous.checkpoint.confirmation) } : loop.attempt.pauseSource && clone(loop.attempt.pauseSource);
          if (loop.attempt.restore && !confirmedPausePending() && loop.attempt.restore.authority?.confirmedPause) {
            const source = pauseSource ?? { checkpoint: clone(invocation.taskFrame.sources.at(-1)),
              confirmation: clone(loop.attempt.restore.authority.confirmedPause) };
            pauseSource = source;
          }
          if (pauseSource && !invocation.taskFrame.restorationKeys.includes(loop.attempt.checkpoint.key)) {
            invocation.taskFrame.restorationKeys.unshift(loop.attempt.checkpoint.key);
            (invocation.taskFrame.sources ??= []).unshift(clone(loop.attempt.checkpoint));
          }
          const source = loop.attempt;
          const repair = invocation.taskFrame.reviewRepair;
          if (repair && !repair.attempt) repair.attempt = previous.attempt + 1;
          const peak = source.gate?.receipt?.contextPeak ?? null;
          const revival = { opinion: previous.revival?.opinion ?? "fresh", reason: previous.revival?.reason ?? "",
            ...decideRevival(source, { taskId: task.id, loop: loop.number, candidate: currentCandidate,
              halt: loop.halt, revivalContextPeak: invocation.revivalContextPeak }, peak), peak };
          if (repair) Object.assign(revival, { decision: "fresh", code: "task-review-repair" });
          loop.attempt = { taskId: task.id, index: loop.cursor, number: previous.attempt + 1,
            revival, ...(revival.decision === "resume" && !repair ? { resume: source.launch.runId,
              bindingKey: source.bindingKey ?? source.key, resumeAfter: source.gate.receipt.after,
              boardPostIds: source.boardPostIds ?? [] } : {}),
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${previous.attempt + 1}`,
            stage: "intention", undispatched: true, continuationRef: previous.ref,
            ...(source.foldedNextBaseline ? { checkpoint: clone(source.foldedNextBaseline), foldedBaseline: clone(source.foldedNextBaseline) } : {}),
            ...(pauseSource ? { pauseSource } : {}) };
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
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a1`, stage: "intention", continuationRef: null };
          await save();
        }
        if (loop.attempt.restore || loop.attempt.resumeRejection) await observeMainRequests();
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
        const baseline = folded ? { candidate: folded.baseline } : await loopIO("baselineIO", { operation: "baseline", root: config.root,
          intent: clone(loop.attempt.checkpoint) }, loop.attempt);
        if (folded) loop.attempt.checkpoint = clone(folded);
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
          const source = invocation.taskFrame.sources.find(item => item.key === sourceKey);
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
COMPLETE SELECTED TASK:\n${JSON.stringify(task)}
TASK CONTINUATION (data):
${JSON.stringify({ metricSeries: loop.metricSeries ?? task.progress ?? null,
  handoff: invocation.tasks[task.id]?.last?.knowledge?.handoff ?? "",
  board: invocation.currentView ?? null,
  gateFailures: invocation.tasks[task.id]?.last?.gateFailures ?? null,
  previousResult: descriptor.continuationRef?.outputReference ?? descriptor.continuationRef?.outputArtifactPath ?? null })}
TASK REVIEW REPAIR (blocking findings and synthesis original; read that original in full):
${JSON.stringify(invocation.taskFrame.reviewRepair ?? null)}
No other agents of this execution run concurrently. resource_snapshot is enough for host load;
do not ask the supervisor about concurrency. Current DECISIONs are binding working rules:
no reconfirmation is needed and they cannot expand scope. Authority: spec, frozen amendments and current HUMAN rulings (most recent human source wins; cite it) > DECISION > FINDING > HANDOFF; code wins over any map.
${descriptor.restore ? `CHECKPOINT FALLBACK (same pending task, not a metadata repair):
${JSON.stringify(descriptor.restore)}
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
${JSON.stringify(descriptor.checkpoint)}
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
ORIGINAL COMPLETE PLAN REFERENCES (fallback, never previews): ${JSON.stringify(loop.plan.ref)}
If the selected task is unavailable inline, read it from ${invocation.backlogPath}; verify its ID ${JSON.stringify(task.id)}
and admitted backlog digest ${invocation.backlogDigest} before effects. Never reconstruct a task from director previews.
No definition => report blocked, never reconstruct scopes. Continuation reads the exact preceding result
${JSON.stringify(descriptor.continuationRef)} and addresses only useful diagnosed pending work on THIS task.
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
          const intents = invocation.taskFrame.reviewIntents ??= [];
          if (!intents.some(intent => intent.key === descriptor.key)) intents.push(clone(descriptor.checkpoint));
          loop.results.push({ ...projection(descriptor.key, result), taskId: task.id, attempt: descriptor.number,
            status: "rejected", revival: { ...descriptor.revival, decision: "fresh", code: "resume-rejected" },
            diagnosis: rejection.reason });
          loop.attempt = { taskId: task.id, index: loop.cursor, number: descriptor.number + 1,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${descriptor.number + 1}`,
            stage: "intention", undispatched: true, continuationRef: descriptor.continuationRef,
            revival: { ...descriptor.revival, decision: "fresh", code: "resume-rejected" }, resumeRejection: rejection };
          await save();
          continue;
        }
        loop.attempt.launch = nativeReference(descriptor.key, result);
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
          throw nativeBarrier(barrier(result));
        }
        loop.attempt.stage = "launched";
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
      const acceptanceTask = { id: "final-acceptance", gates: loop.acceptance.map(command => ({ ...command,
        timeoutMs: command.timeoutMs ?? 1800000 })), metric: null };
      const finalAttempt = loop.finalAttempt ??= { key: `${key}.l${loop.number}.acceptance`, number: 1 };
      const exec = acceptanceTask.gates.map(({ id, command, cwd, timeoutMs }) => ({ id, command, cwd, timeoutMs }));
      const previous = invocation.lastFinalAcceptance;
      const reuse = !finalAttempt.freshAuthorized && previous?.loop < loop.number && same(previous.exec, exec) ? previous : undefined;
      let receipt = await verifyAttempt(finalAttempt, acceptanceTask, { status: "complete", knowledge: {} }, reuse);
      if (receipt.reused && !currentAcceptance() && invocation.freshAcceptanceAuthorized && !receipt.mutated) {
        // Consume authorization with the fresh intention, before any command can launch.
        invocation.freshAcceptanceAuthorized = false;
        finalAttempt.freshAuthorized = true;
        finalAttempt.gate = { key: `${finalAttempt.key}.fresh.gate`, stage: "intention", retry: 0 };
        await save();
        receipt = await verifyAttempt(finalAttempt, acceptanceTask, { status: "complete", knowledge: {} });
      }
      invocation.freshAcceptanceAuthorized = false;
      if (!receipt.reused && !receipt.mutated && !acceptanceResults().blocking.some(gate => ["timeout", "error"].includes(gate.status))) {
        invocation.lastFinalAcceptance = { loop: loop.number, gateKey: finalAttempt.gate.ref?.key ?? finalAttempt.gate.key,
          candidate: candidate(receipt.after), exec, results: clone(receipt.gates) };
      }
      await save();
      if (receipt.reused && !currentAcceptance()) {
        loop.halt = { status: "blocked", code: "repeat-acceptance",
          reason: `Repeated final acceptance from loop ${receipt.reused.loop} (${receipt.reused.gateKey}) still fails: ${acceptanceResults().blocking.filter(gate => gate.status !== "pass" || gate.exit !== 0).map(gate => `${gate.id}: ${gate.status} (${gate.logRef})`).join("; ")}` };
        await save(); return finish("blocked", loop.halt.reason);
      }
      recordOriginalProblem(acceptanceTask, receipt, finalAttempt);
      const environment = acceptanceResults().blocking.filter(gate => ["timeout", "error"].includes(gate.status));
      if (environment.length) {
        loop.halt = { status: "blocked", code: "environment", reason: `Final acceptance environment failure: ${environment.map(gate => `${gate.id}: ${gate.status} (${gate.logRef})`).join("; ")}` };
        await save(); return finish("blocked", loop.halt.reason);
      }
      if (!currentAcceptance()) {
        const failed = acceptanceResults().blocking.filter(gate => gate.status === "fail");
        if (failed.length) await recordFinalGaps("acceptance", failed.map(gate => ({
          reason: `Final acceptance gate ${gate.id} failed (exit ${gate.exit}): ${gate.logRef}`,
          source: `Final acceptance gate ${gate.id}`,
        })), failed.map(gate => ({ key: finalAttempt.gate.key, path: gate.logRef })));
        loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
        loopReport("gaps", `Final acceptance failed or candidate changed: ${JSON.stringify(receipt)}`);
        continue;
      }
      loop.candidate = candidate(receipt.after);
      loop.phase = "review"; await save();
    }
    if (loop.phase === "review") {
      if (loop.kind !== "final" || !currentAcceptance()) throw new Error("Final review requires current acceptance gates on the same candidate.");
      await reconcileAnalysis();
      progress();
      let reviewBudgetError;
      // reviewPhase owns its fixed+risk angles mirrored over two slots, then synthesis.
      // Replay reconciles each retained call; repeating a key is not observation.
      // The deterministic access verifier is idempotent, model-free and writes only
      // receipts: dispatch it directly, not as a retained model analysis call.
      const reviewRuns = { all: requests => (requests.every(request => request.agent === "pitako.access-verifier")
        ? dispatch(requests.map(request => ({ ...request, cwd: config.root, reads: false, progress: false })))
        : analysisDispatch(requests.map(request => ({
        ...request, cwd: config.root, reads: false, progress: false,
      }))).then(results => {
        results.forEach((result, index) => usage(result, requests[index].key));
        return results;
      })).catch(error => {
        if (error?.spawnBudgetExhausted) reviewBudgetError = error;
        throw error;
      }) };
      const reviewed = await reviewPhase({
        workDescription: `Loop ${loop.number} result — ${(selectedTasks().map(task => task.goal)).map(goal => goal.replace(/\s+/g, " ").trim()).join("; ")}`,
        brief: `${fullContext()}\nReview the COMPLETE authorized result against ALL specs, not director tasks alone.
Admitted COMPLETE plan references: ${JSON.stringify(loop.plan.ref)}.
Assess single-outcome decomposition and necessary dependencies independently; schema cannot certify semantics.
Do not repeat correct completed implementation merely to improve its past decomposition.
Candidate including WIP: ${JSON.stringify(loop.candidate)}.
Actual final checks/result references: ${JSON.stringify(loopResults())}.
Done/obsolete tasks (bounded summary: title or clipped goal and last reason; omitted counts tasks beyond the cap): ${JSON.stringify(loop.completedTasks)}.
Complete goals and histories of every task: ${invocation.backlogPath}.
Authority: spec, frozen amendments and current HUMAN rulings (most recent human source wins; cite it) > DECISION > FINDING > HANDOFF; code wins over any map.
Current Board HUMAN rulings, DECISIONs and authority: ${JSON.stringify(invocation.currentView)}.
${acceptanceBrief()}
No own writer is active. Do not run checks or repair. Only clear screening permits compliance.`,
        target: { kind: "solution", reference: JSON.stringify(loop.candidate),
          material: `Entire designated checkout ${config.root}, immutable full specs above and native work/check artifacts.
Read the actual sources and full referenced reports, not previews. Candidate: ${JSON.stringify(loop.candidate)}.` },
      }, reviewRuns, { prefix: `${key}.l${loop.number}.review.`, mode: "execute",
        models: invocation.reviewModels,
        decisionReference: { stateKey: key, loop: loop.number, plan: loop.plan.ref, candidate: loop.candidate },
        access: { missionPath: config.missionPath, namespace: `execute-${config.invocation}` },
      });
      if (reviewBudgetError) throw reviewBudgetError;
      if (persistenceFailed) throw new Error(persistenceReason);
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
      if (reviewBarrier) throw nativeBarrier(reviewBarrier);
      if (reviewed.nativeBarrier) throw nativeBarrier(reviewed.nativeBarrier);
      if (reviewed.status !== "completed" || reviewed.screening?.verdict === "blocked") {
        const reason = reviewed.screening?.reason ?? reviewed.error ?? "Adversarial review blocked; no compliance or repair launched.";
        loop.halt = reviewed.nativeFailure
          ? { status: "partial", ...reviewed.nativeFailure }
          : { status: "blocked", code: "semantic-block", reason: excerpt(reason) };
        await save();
        return finish(loop.halt.status, loop.halt.reason);
      }
      if (reviewed.screening.verdict !== "clear")
        await recordFinalGaps("review", [{ reason: loop.review.reason }],
          [findingOutput(loop.review.references.find(ref => ref.key.endsWith(".director-synthesis")))]);
      loop.phase = reviewed.screening.verdict === "clear" ? "compliance" : "closing";
      await save();
    }
    if (["compliance", "closing"].includes(loop.phase) && loop.review?.status === "completed") {
      const reviewKey = `review-${key}`, retained = await state.get(reviewKey);
      if (retained?.decision?.reference?.loop === loop.number && retained.originals.some(original => !original.sha256)) {
        const originals = retained.originals.map(original => ({ ...original,
          path: findingOutput(loop.review.references.find(ref => ref.key === original.key)).path,
        }));
        const compact = await loopIO("reviewOriginals", { operation: "reviewOriginals", originals });
        await state.set(reviewKey, { ...retained, originals: compact.originals });
        const synthesis = compact.originals.find(original => original.key.endsWith(".director-synthesis"));
        loop.reviewSynthesis = { key: synthesis.key, path: synthesis.path, sha256: synthesis.sha256 };
        delete loop.reviewOriginals;
        await save();
      } else if (retained?.decision?.reference?.loop === loop.number && !loop.reviewSynthesis) {
        const synthesis = retained.originals.find(original => original.key.endsWith(".director-synthesis"));
        loop.reviewSynthesis = { key: synthesis.key, path: synthesis.path, sha256: synthesis.sha256 };
        delete loop.reviewOriginals;
        await save();
      }
    }
    if (loop.phase === "compliance") {
      if (loop.kind !== "final" || !currentAcceptance() || loop.review?.verdict !== "clear")
        throw new Error("Final compliance requires current acceptance and clear review on the same candidate.");
      await reconcileAnalysis();
      const completedReview = await state.get(`review-${key}`);
      const complianceKey = `${key}.l${loop.number}.compliance`;
      const result = await collect(complianceKey, "pitako.reviewer",
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
Admitted COMPLETE plan references: ${JSON.stringify(loop.plan.ref)}.
Independently assess single-outcome decomposition and dependency completeness against the full spec;
structural validation cannot prove them. Do not repeat correct work to improve past decomposition.
Read the actual full reports and sources via exact refs. Green/TODO/completed is not fulfillment.
Return fulfilled ONLY with reasoned complete requirements coverage, current mandatory checks,
no unresolved material gaps and this SAME candidate. Otherwise gaps or blocked. No post-review repair.`,
        complianceSchema, false, analysisDispatch);
      const value = result?.structuredOutput;
      const complianceRef = loop.compliance?.ref;
      // The judged candidate is workflow-known (it is in the prompt); never a model echo.
      loop.compliance = { ...projection(complianceKey, result), candidate: candidate(loop.candidate),
        reason: excerpt(value?.reason),
        unresolved: Array.isArray(value?.requirements) ? value.requirements.filter(item => ["gap", "blocked"].includes(item?.status))
          .map(item => ({ id: item.id, source: item.source, status: item.status, reason: item.reason })) : [] };
      loop.compliance.ref = { ...complianceRef, ...loop.compliance.ref };
      if (barrier(result)) throw nativeBarrier(barrier(result));
      if (!result?.ok || !["fulfilled", "gaps", "blocked"].includes(value?.status) || !text(value.reason) ||
          !Array.isArray(value.requirements) || !value.requirements.length ||
          new Set(value.requirements.map(item => item?.id)).size !== value.requirements.length ||
          value.requirements.some(item => !text(item?.id) || !text(item.source) || !text(item.reason) ||
            !["fulfilled", "gap", "blocked", "not-applicable"].includes(item.status) ||
            !Array.isArray(item.evidence) || !item.evidence.length ||
            !Array.isArray(item.checks) || !item.evidence.every(text) || !item.checks.every(text)) ||
          (value.status === "fulfilled" && (!value.requirements.some(item => item.status === "fulfilled") ||
            value.requirements.some(item => !["fulfilled", "not-applicable"].includes(item.status)))))
        throw new Error("Compliance lacks a meaningful source/reason/current-evidence requirements inventory.");
      if (value.status === "blocked") {
        loop.halt = { status: "blocked", code: "semantic-block", reason: excerpt(value.reason) };
        await save(); return finish("blocked", loop.halt.reason);
      }
      if (unfulfilledCancellations().length) {
        loop.compliance.status = "gaps";
        loop.compliance.reason = unfulfilledCancellations().map(task => `${task.id}: ${task.cancel.reason}`).join("; ");
        loop.compliance.unresolved.push(...unfulfilledCancellations().map(task => ({ id: task.id,
          source: "main-session request", status: "gap", reason: task.cancel.reason })));
      }
      if (loop.compliance.status === "gaps")
        await recordFinalGaps("compliance", loop.compliance.unresolved.length ? loop.compliance.unresolved : [{ reason: loop.compliance.reason }],
          (loop.compliance.unresolved.length ? loop.compliance.unresolved : [null]).map(() => findingOutput(loop.compliance.ref)));
      loop.phase = "closing"; await save();
    }
    if (loop.phase === "closing") {
      if (invocation.intentions?.length) await groupedIO("closingDrain", { operation: "drain" });
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
           observed = fresh ? (await dispatch([{ key: intention.key, agent: "pitako.checkout-observer",
             task: JSON.stringify({ expected: { invocation: config.invocation, ...loop.archivePending.expected },
               body: { record: closingRecord(), ...(loop.archivePending.expected.count === 0
                 ? { spec: { content: config.preliminary.content, digest: invocation.association.digest } } : {}) } }), cwd: config.root, context: "fresh",
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
         if (cause && (intention.validated || !fresh)) throw nativeBarrier(cause, intention.ref);
         let observation = intention.validated;
         if (observation) {
           if (intention.stage !== "receipt" || intention.ref?.key !== intention.key ||
               !text(intention.ref?.runId) || !text(intention.ref?.asyncDir) ||
               intention.ref?.agent !== "pitako.checkout-observer" ||
               !text(intention.ref?.externalAdapter?.outputArtifacts?.stdoutPath) ||
               !text(intention.ref?.externalAdapter?.outputArtifacts?.stderrPath) ||
               utf8Bytes(JSON.stringify(observation)) > 61440 || observation.version !== 1 || observation.ok !== true ||
               Object.keys(observation).sort().join(",") !== "checkout,commonDir,ledger,ok,root,summaries,version" ||
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
           if (cause) throw nativeBarrier(cause, intention.ref);
           const errors = [observed, ...(observed?.results ?? [])].filter(Boolean);
           if (!observed?.ok || !text(observed.runId) || !text(observed.asyncDir) ||
               observed.agent !== "pitako.checkout-observer" || observed.state !== undefined || observed.terminalOutcome ||
               (observed.key !== undefined && observed.key !== intention.key) ||
               errors.some(item => item.error || item.outputSaveError || item.metadataSaveError || item.transcriptError ||
                 item.outputPartial || item.truncation || item.timedOut || item.processSignal ||
                 item.exitCode !== undefined && item.exitCode !== 0) ||
               (!Array.isArray(observed.results) || observed.results.length !== 1 || observed.results[0]?.exitCode !== 0) ||
               !text(observed.externalAdapter?.outputArtifacts?.stdoutPath) ||
               !text(observed.externalAdapter?.outputArtifacts?.stderrPath))
             throw new Error(`Closing observation ${intention.key} lacks successfully published terminal evidence (${observed?.error ?? "status/artifacts unavailable or invalid"}). Inspect the exact native run and output references; reconcile capture, publication or native capacity before continuation, never infer completion or redispatch.`);
           if (typeof observed.output !== "string" || utf8Bytes(observed.output) > 61440)
             throw new Error(`Invalid closing stdout for ${intention.key}; inspect its native stdout reference, not a preview or truncated tail.`);
           try { observation = JSON.parse(observed.output); }
           catch { throw new Error(`Invalid closing JSON document for ${intention.key}; retain stdout/stderr and reconcile the exact native producer without redispatch.`); }
           if (observation?.error === "ledger-integrity")
             throw Object.assign(new Error(`Ledger integrity requires human reconciliation: ${observation.reason}`), { ledgerIntegrity: true });
           if (!observation || observation.version !== 1 || observation.ok !== true ||
               Object.keys(observation).sort().join(",") !== "checkout,commonDir,ledger,ok,root,summaries,version" ||
               observation.root !== invocation.association.root || observation.commonDir !== invocation.association.commonDir ||
               !validLoopAnchor(observation.ledger) || !validSummaries(observation.summaries) || !candidate(observation.checkout) ||
               Object.keys(observation.checkout ?? {}).sort().join(",") !== "fingerprint,head")
             throw new Error(`Invalid closing observation or physical workspace mismatch for ${intention.key}; expected ${invocation.association.root} / ${invocation.association.commonDir}, observed ${observation?.root ?? "unavailable"} / ${observation?.commonDir ?? "unavailable"}. ${observation?.ok === false ? [observation.reason, observation.nextStep].filter(text).join(" ") : "Inspect the exact native stdout/stderr and designated cwd; preserve the snapshot and pending intention."}`);
           // Retain only the validated candidate/workspace projection, not potentially large Git status text.
           observation = { version: 1, ok: true, root: observation.root, commonDir: observation.commonDir,
             checkout: candidate(observation.checkout), ledger: observation.ledger, summaries: observation.summaries };
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
         invocation.ledger = observation.ledger;
         loop.closing = { candidate: candidate(observation.checkout),
           sameCandidate: same(candidate(observation.checkout), loop.candidate),
           observation, ref: intention.ref };
         intention.stage = "receipt";
         try { await save(); } catch (error) { invocation.ledger = oldLedger; delete loop.closing; throw error; }
         intention.stage = "complete";
         delete intention.validated;
        } catch (error) {
          if (error.terminalPersistence || error.spawnBudgetExhausted || error.ledgerIntegrity || error.nativeBarrier || error.nativeFailure?.code === "capacity" ||
              /Closing archive source fields changed|Invalid retained closing evidence|producer identity changed|reuses another loop/.test(error.message)) throw error;
          if (closeTries >= 3) throw new Error(`Checkout publication pending: three attempts failed (${error.message}); repeated failure requires operator repair.`);
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
      if (fulfilled) return finish("complete", "Whole-spec fulfillment and mandatory checks verified for the current candidate. No more loops required.");
      loopReport("gaps", !loop.closing.sameCandidate ? "Candidate changed; affected checks and analyses are stale."
        : "Material adversarial or compliance gaps remain; next director receives exact evidence.");
    }
  }
} catch (error) {
  let reason = String(error?.message ?? error);
  if (canSaveBudgetExhaustion(error)) {
    try {
      return await finishBudgetExhaustion();
    } catch (saveError) { reason += ` ${String(saveError?.message ?? saveError)}`; }
  }
  if (error?.hostHalt) {
    hostHalt = error.hostHalt;
    references.push(hostHalt.ref);
    // Before snapshot capture there is no admitted association to invent. Keep
    // only the concrete request/operation observation on the existing state key.
    if (resolution) resolution.failedHostObservation = clone(hostHalt);
    if (hostReconstruction) {
      hostReconstruction.stage = "failed";
      hostReconstruction.failure = clone(hostHalt);
    }
    try { await persistState(key, { ...(invocation ?? { version: config.stateVersion }), hostHalt }); }
    catch (saveError) {
      persistenceFailed = true;
      persistenceReason = `Essential persistence failed; host observation could not be retained: ${String(saveError?.message ?? saveError)}`;
    }
    return finish(hostHalt.status, `${hostHalt.reason} ${reason}`);
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
  if (loop && !persistenceFailed && admissionValidated) {
    if (error?.backlogConflict) loop.halt = { status: "blocked", code: "backlog-conflict", reason: excerpt(reason) };
    if (error?.nativeBarrier) {
      const ref = error.nativeReference ?? resolution?.currentBarrier?.ref ?? loop.attempt?.launch ?? loop.halt?.ref ?? { key };
      if (resolution) resolution.currentBarrier = { cause: error.nativeBarrier, ref: clone(ref) };
      if (loop.halt && loop.attempt) loop.attempt.interruption ??= clone(loop.halt);
      loop.halt = { status, code: "native-barrier", cause: error.nativeBarrier,
        reason: excerpt(reason), ref: clone(ref) };
    }
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
