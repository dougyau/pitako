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
const associationSchema = object({
  missionId: string, missionPath: string, invocation: string, loop: integer,
  root: string, commonDir: string, source: string, digest: string,
});
const checkDefinitionSchema = object({ id: string, requirement: string, command: string, cwd: string });
const taskSchema = object({
  id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
  kind: { enum: ["implementation", "verification"] }, goal: string,
  contextRefs: list(string), sourceRefs: list(string), scope: list(string),
  allowedEffects: list(string), expectedResult: string,
  dependsOn: list(object({ taskId: string, reason: string })),
  checks: { ...list(checkDefinitionSchema), minItems: 1 },
});
const planSchema = object({
  status: { enum: ["plan", "needs-decision"] }, reason: string,
  association: associationSchema,
  sharedContext: object({ material: string, references: list(string) }),
  tasks: list(taskSchema),
});
const checkSchema = object({
  id: string, requirement: string, command: string, cwd: string,
  output: string, logPaths: list(string), result: { enum: ["passed", "failed", "not-run"] },
  before: nullable(candidateSchema), after: nullable(candidateSchema),
});
// The admitted plan owns requirement text; an optional worker echo is descriptive only.
checkSchema.required = checkSchema.required.filter(field => field !== "requirement");
const workerSchema = object({
  taskId: string, attempt: integer, status: { enum: ["complete", "continue", "gaps", "blocked"] },
  workDone: string, remaining: list(string), diagnosis: string,
  usefulProgress: { type: "boolean" }, continuation: nullable(string),
  git: object({ head: string, checkpoints: list(string), wip: string }),
  candidate: candidateSchema, checks: list(checkSchema),
});
workerSchema.properties.restoreReceipt = object({ checkpointRef: string, digest: string,
  partialRef: string, restoredRef: string, candidate: candidateSchema,
  position: object({ loop: integer, cursor: { type: "integer", minimum: 0 }, phase: { const: "implementation" } }) });
workerSchema.properties.restoreReceipt.properties.confirmedPause = object({ checkpointRef: string, digest: string });
workerSchema.properties.checkpointReceipt = object({
  kind: { enum: ["unit", "pause"] }, checkpointRef: string, digest: string, candidate: candidateSchema,
  position: object({ loop: integer, cursor: { type: "integer", minimum: 0 }, phase: { const: "implementation" } }),
  progress: object({ consumedLoops: integer, admittedResults: list({ type: "object" }) }),
});
const complianceSchema = object({
  status: { enum: ["fulfilled", "gaps", "blocked"] }, reason: string,
  candidate: candidateSchema,
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
function continuationIdentity(value) {
  // Bounded equality witness, not authority or a substitute for native reports.
  const encoded = JSON.stringify([value.candidate, value.remaining, value.diagnosis, value.continuation]);
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
  for (const field of ["agent", "runId", "asyncDir", "outputReference", "outputArtifactPath", "outputPathMapping", "artifactPaths"])
    if (result?.[field] !== undefined) ref[field] = result[field];
  const witnesses = result?.results?.filter(entry => text(entry.structuredOutputPath))
    .map(entry => ({ structuredOutputPath: entry.structuredOutputPath }));
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
  return Promise.resolve().then(() => retainNativeCall(runs.all(requests))).then(results => {
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
function host(grant) {
  if (!grant) return Promise.reject(new Error("Missing trusted inspection grant."));
  let receipt;
  return retainNativeCall(runs.host(grant.key, { kind: "command", command: grant.command, timeoutMs: 86400000 })).then(result => {
    receipt = result;
    if (text(result.outputPath)) references.push({ key: grant.key, outputReference: result.outputPath });
    if (barrier(result)) throw nativeBarrier(barrier(result));
    if (!result.ok) throw new Error([result.error || "Read-only inspection failed.", result.stderr].filter(Boolean).join("\n"));
    return JSON.parse(result.stdout);
  }).catch(error => {
    // The native wrapper discards the receipt on failure. This exact message at
    // this boundary is compatible with abort, but identical command output can
    // produce it too: retain the ambiguity, never manufacture a Stop receipt.
    if (/^Blocked by pi-subagents permission rule:/.test(String(error?.message ?? error)))
      error.nativeBarrier = "native permission denial";
    error.hostHalt = { status: ["stopped", "interrupted"].includes(error.nativeBarrier) ? "cancelled" : "blocked", code: "host-observation",
        reason: error?.message === `Host command '${grant.key}' failed: Command stopped because the workflow was aborted.`
          ? "Native host abort/failure observation is ambiguous; retain the unknown cause for bounded reconstruction under current native authority."
          : "Read-only host inspection failed; retain its observation for bounded reconstruction under current native authority.",
        ref: { key: grant.key }, command: grant.command,
        observedError: String(error?.message ?? error), request: hostRequest(),
        ...(receipt?.state !== undefined ? { observedState: receipt.state } : {}),
        ...(error.nativeBarrier ? { observedBarrier: error.nativeBarrier } : {}),
        ...(receipt?.outputPath !== undefined ? { outputReference: receipt.outputPath } : {}) };
    throw error;
  });
}
function hostRequest() {
  return { missionId: config.missionId, missionPath: config.missionPath,
    invocation: config.invocation, root: config.root, id: config.id,
    inspectionCommand: config.inspections[0].command, sourceRefs: config.sourceRefs ?? [] };
}
function capture(current) {
  const header = current.transport;
  const count = header?.chunks ?? current.selected.chunks;
  if (!Number.isInteger(count) || count < 1 || count > 26) throw new Error("Invalid snapshot chunk count.");
  if (header && (!/^[a-f0-9]{64}$/.test(header.digest ?? "") ||
      !Number.isInteger(header.bytes) || header.bytes < 1 || header.bytes > 26 * 4096 ||
      !Number.isInteger(header.contentBytes) || header.contentBytes < 1 || header.contentBytes > 39936))
    throw new Error("Invalid inspection metadata header.");
  let reconstruction = Promise.resolve({ encoded: "", content: "" });
  for (let index = 0; index < count; index++) {
    reconstruction = reconstruction.then(snapshot => host(config.chunks[index]).then(chunk => {
      if (chunk.digest !== current.selected.digest || typeof chunk.content !== "string" ||
          utf8Bytes(chunk.content) > 1539 || utf8Bytes(JSON.stringify(chunk) + "\n") > 4096 ||
          (header && (chunk.index !== index || chunk.chunks !== count ||
            chunk.metadataDigest !== header.digest || typeof chunk.metadata !== "string")))
        throw new Error("Snapshot changed or returned an invalid chunk.");
      return { encoded: snapshot.encoded + (chunk.metadata ?? ""), content: snapshot.content + chunk.content };
    }));
  }
  return reconstruction.then(({ encoded, content }) => {
    if (!text(content) || utf8Bytes(content) > 39936 ||
        (header && (utf8Bytes(encoded) !== header.bytes || utf8Bytes(content) !== header.contentBytes)))
      throw new Error("Incomplete snapshot reconstruction.");
    const metadata = header ? JSON.parse(encoded) : current;
    if (header && (JSON.stringify(metadata) !== encoded || metadata.selected?.digest !== current.selected.digest))
      throw new Error("Invalid inspection metadata reconstruction.");
    return { metadata: { ...metadata, checkout: current.checkout }, content };
  });
}
let invocation, loop, activePlan, currentCandidate, checkpointObservation, replay = false;
let hostHalt, resolution, hostReconstruction;
let inspectedAnalyses = [];
let persistenceFailed = false;
let persistenceReason = null;
function maxCycles() { return invocation?.version === 3 ? invocation.association?.maxCycles ?? null : 3; }
function hostCapacityHalt() {
  return { status: "partial", code: "capacity",
    reason: "Native host inspection capacity exhausted before next director; required closing inspection cannot be omitted.",
    ref: { key: "host-inspection-capacity" } };
}
function save() {
  // The native setter measures the ENTIRE merged file, including unrelated keys.
  // Essential state is committed first. One optional identical active plan cannot
  // displace snapshot, frozen descriptor, progress, or historical records.
  const essential = { ...invocation, activePlan: null };
  return state.set(key, essential).catch(error => {
    persistenceFailed = true;
    persistenceReason = `Essential persistence failed; dispatch halted: ${String(error?.message ?? error)}`;
    throw new Error(persistenceReason);
  }).then(() => activePlan ? state.set(key, { ...essential, activePlan }).catch(error => {
    if (!/Mission state exceeds the 256 KiB limit/.test(String(error?.message ?? error)))
      throw new Error(`Optional active-plan persistence failed; dispatch halted: ${String(error?.message ?? error)}`);
  }) : undefined);
}
function progress() {
  const value = {
    type: "execution-progress", invocation: config.invocation, loop: loop?.number ?? 0,
    loopsConsumed: invocation?.loops?.length ?? 0, maxLoops: maxCycles(),
    label: `Loop ${loop?.number ?? 0} de ${maxCycles()}`, phase: loop?.phase ?? "admission",
    ...(loop?.attempt ? { taskId: loop.attempt.taskId, attempt: loop.attempt.number } : {}),
    elapsedMs: invocation ? Date.now() - invocation.startedAt : null, tokens: metrics(),
    action: action("gaps", "Next existing operation; no new dispatch claimed by this progress event."),
  };
  if (typeof emit === "function") emit(value);
  return value;
}
function metrics(selectedLoop) {
  const values = (selectedLoop ? [selectedLoop] : invocation?.loops ?? []).flatMap(item => item.usage ?? []);
  const known = values.filter(item => item.tokens !== null);
  return { value: known.length ? known.reduce((total, item) => total + item.tokens, 0) : null,
    coverage: !known.length ? "unavailable" : known.length === values.length ? "reported" : "partial" };
}
function usage(result, childKey) {
  if (!loop) return;
  // SingleResult.usage is reported by the runtime. Count each producer once,
  // including replay. Never sum both aggregate and per-child usage.
  const entries = result?.results?.length ? result.results : [null];
  entries.forEach((entry, index) => {
    const id = `${result?.runId ?? childKey}:${index}`;
    if (invocation.loops.some(item => item.usage.some(value => value.id === id))) return;
    const reported = entry?.usage;
    const fields = ["input", "output", "cacheRead", "cacheWrite"];
    const tokens = reported && fields.every(field => Number.isFinite(reported[field]) && reported[field] >= 0)
      ? fields.reduce((total, field) => total + reported[field], 0) : null;
    loop.usage.push({ id, tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : null });
  });
}
function projection(childKey, result) {
  const statuses = ["plan", "needs-decision", "complete", "continue", "gaps", "blocked",
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
    let lines = typeof observed?.output === "string" ? observed.output.split(/\r?\n/) : [];
    if (lines[0] === `Status target: run ${ref.runId ?? ref.key}` &&
        /^Spawn budget:/.test(lines[1] ?? "") && /^Active async capacity:/.test(lines[2] ?? ""))
      lines = lines.slice(3);
    if (original.state !== "complete" && !(observed?.ok && (observed.state === "complete" ||
        ((lines[0] === `Run: ${ref.runId ?? ref.key}` || lines[0] === `Nested run: ${ref.runId ?? ref.key}`) && lines.includes("State: complete")))))
      throw new Error(`Read-only producer settlement uncertain for ${ref.runId ?? ref.key}; no replacement dispatched.`);
    observed = { ...ref, ...original, reused: true };
  }
  return observed;
}
function observeAnalysis(call) {
  const ref = call.ref.runId ?? call.key;
  return observeStatus(ref).then(observed => {
    if (call.ref.runId && observed?.runId && call.ref.runId !== observed.runId)
      throw new Error("Analysis producer/run identity conflicts with retained receipt.");
    const cause = barrier(observed, ref);
    if (cause) throw nativeBarrier(cause);
    observed = retainedReadOnlyOriginal(observed, call.ref);
    if (!observed?.ok || !text(observed.runId) || !observed.structuredOutput) {
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
  const calls = [...(loop.analysisCalls ?? [])];
  for (const ref of [...(loop.review?.references ?? []), loop.compliance?.ref].filter(Boolean)) {
    if (!calls.some(call => call.key === ref.key))
      calls.push({ key: ref.key, stage: "receipt", ref: { key: ref.key, ...(text(ref.runId) ? { runId: ref.runId } : {}) },
        barrier: ref.barrier ?? barrier(ref) });
  }
  if (!hasIntentions && loop.halt?.code === "native-barrier" && !calls.some(call => call.barrier))
    return Promise.reject(nativeBarrier(loop.halt.cause ?? "analysis receipt unavailable; settlement uncertain"));
  loop.analysisCalls = calls;
  // Observe the whole retained group before a missing sibling may be launched.
  return (loop.analysisCalls ?? []).reduce((settled, call) =>
    settled.then(() => analysisResults.get(call.key) ?? observeAnalysis(call)), Promise.resolve()).then(() => {
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
// A pointer is not proof of modifying work: verification tasks receive frozen
// descriptors too. Only the complete admitted definition chooses rollback.
function pendingCheckpointUnit() {
  return loop?.phase === "implementation" && loop.attempt?.checkpoint && !loop.attempt.result &&
    activePlan?.tasks?.[loop.cursor]?.id === loop.attempt.taskId &&
    activePlan.tasks[loop.cursor].kind === "implementation";
}
const reconciledRecoveries = new Map();
function reconcileRetainedRecoveries() {
  const needsPlan = loop.phase === "implementation" && loop.attempt?.checkpoint && !loop.attempt.result && !activePlan;
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
        if (recovery.phase !== "attempt-result" || activePlan) return value;
        // The optional full-plan cache is not an authority prerequisite. Resolve
        // the saved admitted definition, never a new inspector or a rebuilt task.
        const ref = loop.plan.ref;
        return observeStatus(ref.runId ?? ref.key).then(result => {
          const cause = barrier(result, ref.runId ?? ref.key);
          if (cause) throw nativeBarrier(cause);
          planAuthority(result?.structuredOutput, result);
          validatePlan(result.structuredOutput, loop.number, loop.manifest);
          activePlan = result.structuredOutput;
          return value;
        });
      }).then(value => {
        if (value.status === "unresolved")
          throw new Error(`Retained recovery unresolved: ${value.reason}`);
        if (recovery.phase === "loop-plan") {
          if (value.status === "recovered") {
            if (!value.originalAvailable || !value.original)
              throw new Error("Retained plan recovery lacks the complete original.");
            planAuthority(value.original);
            if (activePlan && !same(activePlan, value.original)) planConflict("Conflicting complete loop_plan values.");
            validatePlan(value.original, loop.number, loop.manifest);
          } else if (loop.plan.stage === "admitted")
            throw new Error("Retained admitted plan recovery lacks the complete original.");
        } else if (recovery.phase === "attempt-result") {
          const task = activePlan?.tasks?.find(item => item.id === loop.attempt?.taskId);
          if (value.status !== "recovered" || !value.workerResult || !task)
            throw new Error("Retained writer recovery lacks a complete result/task definition.");
          const parsed = workerValue({ ok: true, agent: "pitako.worker", runId: recovery.source.runId,
            structuredOutput: value.workerResult }, loop.attempt, task, recovery.source.runId ?? recovery.source.key);
          if (parsed.value.status === "blocked")
            throw new Error(`Retained writer recovery remains blocked: ${parsed.value.diagnosis}`);
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
  return Promise.all(requests.map(request => Promise.resolve().then(() => {
    loop.analysisCalls ??= [];
    let call = loop.analysisCalls.find(entry => entry.key === request.key);
    if (call) return analysisResults.get(call.key) ?? observeAnalysis(call);
    call = { key: request.key, stage: "intention", ref: { key: request.key } };
    loop.analysisCalls.push(call);
    return save().then(() => {
      if (persistenceFailed) throw new Error(persistenceReason);
      return dispatch([request]);
    }).then(([result]) => {
      call.stage = "receipt";
      call.ref = { key: request.key, ...(text(result?.runId) ? { runId: result.runId } : {}) };
      call.barrier = barrier(result);
      return save().then(() => {
        if (call.barrier) throw nativeBarrier(call.barrier);
        analysisResults.set(call.key, result);
        return result;
      });
    }, error => {
      if (persistenceFailed) throw error;
      call.stage = "receipt";
      call.barrier = error?.nativeBarrier ?? null;
      return save().then(() => { throw error; });
    });
  })));
}
function collect(childKey, agent, display, task, outputSchema, implementation = false, dispatcher = dispatch, resume) {
  const label = display.label.replace(/\s+/g, " ").trim().slice(0, 120);
  progress();
  return dispatcher([{
    key: childKey, ...(resume ? { resume } : { agent, context: "fresh" }), label, phase: display.phase, cwd: config.root,
    output: `${childKey}.json`, outputMode: "file-only", reads: false, progress: false,
    skill: ["verify-behavior"], task: `${label}\n\n${task}`, outputSchema,
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
  if (!value || !["plan", "needs-decision"].includes(value.status) || !text(value.reason) ||
      !same(value.association, association(loop.number))) planConflict("loop_plan association mismatch.");
  if (result && ((result.agent && result.agent !== "pitako.execution-director") ||
      !text(result.runId) || (loop.plan.ref.runId && result.runId !== loop.plan.ref.runId)))
    planConflict("loop_plan producer/run identity conflict.");
  if (result && text(result.output) && /^[\s]*\{/.test(result.output)) {
    let binding;
    try { binding = JSON.parse(result.output); } catch (_) { planConflict("Invalid complete loop_plan binding JSON."); }
    if (!same(binding, value)) planConflict("Changed/conflicting loop_plan binding; no edits authorized.");
  }
}
function validatePlan(value, number, manifest) {
  if (!value || !["plan", "needs-decision"].includes(value.status) || !text(value.reason) ||
      !same(value.association, association(number))) throw new Error("loop_plan association mismatch.");
  if (value.status === "needs-decision") return value;
  if (!text(value.sharedContext?.material) || !Array.isArray(value.sharedContext.references) ||
      !Array.isArray(value.tasks) || !value.tasks.length ||
      new Set(value.tasks.map(task => task.id)).size !== value.tasks.length ||
      value.tasks.some(task => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.id ?? "") ||
        !["implementation", "verification"].includes(task.kind) ||
        !["goal", "expectedResult"].every(field => text(task[field])) ||
        !["contextRefs", "sourceRefs", "scope", "allowedEffects"].every(field =>
          Array.isArray(task[field]) && task[field].every(text)) ||
        !task.scope.length || !task.sourceRefs.length || !Array.isArray(task.checks) || !task.checks.length ||
        new Set(task.checks.map(check => check.id)).size !== task.checks.length ||
        task.checks.some(check => !["id", "requirement", "command", "cwd"].every(field => text(check[field])))) ||
      value.tasks[value.tasks.length - 1].kind !== "verification")
    throw new Error("loop_plan needs full ordered task scopes and a final verification task, even for existing code.");
  if (manifest && !same(manifest, value.tasks.map(task => task.id)))
    throw new Error("Original loop_plan order or task identity changed.");
  const positions = new Map(value.tasks.map((task, index) => [task.id, index]));
  for (const [index, task] of value.tasks.entries()) {
    let defect = !Array.isArray(task.dependsOn) ? "missing dependsOn array" : task.dependsOn.some(dependency =>
      !dependency || typeof dependency !== "object" || Array.isArray(dependency) ||
      !same(Object.keys(dependency).sort(), ["reason", "taskId"]) ||
      !text(dependency.taskId) || !text(dependency.reason)) ? "invalid {taskId, reason} shape or blank reason" : null;
    if (!defect && new Set(task.dependsOn.map(dependency => dependency.taskId)).size !== task.dependsOn.length)
      defect = "duplicate prerequisite IDs";
    if (!defect && task.dependsOn.some(dependency => !positions.has(dependency.taskId)))
      defect = "unknown prerequisite IDs";
    if (!defect && task.dependsOn.some(dependency => positions.get(dependency.taskId) >= index))
      defect = "self or forward prerequisite IDs";
    if (defect)
      throw new Error(`loop_plan dependencies require unique known earlier task IDs and nonblank reasons; ${defect}; incompatible admitted definitions remain unchanged.`);
  }
  return value;
}
function prerequisiteResults(task) {
  return task.dependsOn.map(dependency => {
    const completed = loop.results.filter(result => result.taskId === dependency.taskId && result.status === "complete");
    if (completed.length !== 1 || !text(completed[0].ref?.key) ||
        !text(completed[0].ref?.runId) || !Number.isSafeInteger(completed[0].attempt) ||
        completed[0].attempt < 1)
      throw new Error(`Prerequisite ${dependency.taskId} has no unique durable completed attempt; no dependent writer dispatched.`);
    return { taskId: dependency.taskId, attempt: completed[0].attempt, ref: completed[0].ref };
  });
}
function fullContext() {
  return `CURRENT HUMAN RESOLUTIONS (accepted input, not new permissions): ${JSON.stringify([
    ...(invocation.resolutions ?? []), ...invocation.loops.flatMap(item => item.resolutions ?? []),
  ])}
ASSOCIATION (data): ${JSON.stringify(association(loop.number))}
COMPLETE IMMUTABLE SPEC SNAPSHOT:\n${invocation.snapshot.content}
ADDITIONAL COMPLETE SPEC SOURCES (immutable path + SHA-256): ${JSON.stringify(invocation.association.sourceRefs ?? [])}
BEFORE reasoning, planning, editing, checking, reviewing or compliance: read EVERY referenced source IN FULL
and verify its SHA-256 with existing read/hash tools. Missing/mismatched/incomplete sources => blocked,
never silently omit inherited obligations or treat summaries as full specs. Selected snapshot remains intact.
ADMITTED PLAN CONTEXT (separate from immutable base association): ${JSON.stringify(activePlan?.sharedContext ?? null)}
Read the COMPLETE admitted plan via its exact retained reference when context is unavailable here.
For separately delivered current human amendments in that context, read and hash the FULL source
before affected work or whole-spec analysis. Retain its path, SHA-256 and human-delivery provenance
in results/reasons alongside unchanged base sources. A missing/changed amendment is a prerequisite
gap, not permission to replace frozen sourceRefs/snapshot/association or renew maxCycles.
Agent text and files alone are not human authority. Preserve known unmet obligations and evidence
limits from the admitted context; new checkpoint observations do not fulfill a missing historical contrast.
Prior loop/result references (data): ${JSON.stringify(invocation.loops.filter(item => item !== loop).map(item => ({
    loop: item.number, outcome: item.outcome, plan: item.plan?.ref,
    rejection: item.plan?.rejection, attempts: item.results,
    review: item.review, compliance: item.compliance, closing: item.closing,
  })))}`;
}
function inspectRecovery(kind, ref, retained) {
  // Subject identity comes from the frozen work, not a replaceable output path
  // or query key. There is one finite observation route for this subject/stage.
  const subject = kind === "checkpoint" ? `checkpoint:${loop.attempt.taskId}:${loop.attempt.number}` : kind === "interrupted-operation" ? `interrupted-operation:${ref.key}` : kind === "loop-plan" ? "loop-plan"
    : `attempt-result:${loop.attempt.taskId}:${loop.attempt.number}`;
  if (loop.recoveries.some(item => !text(item.subject)))
    return Promise.reject(new Error("Retained recovery lacks immutable subject/stage; no replacement query or migration authorized."));
  let recovery = loop.recoveries.find(item => item.subject === subject);
  const existing = !!recovery;
  const producer = kind === "loop-plan" ? loop.plan?.ref : kind === "attempt-result"
    ? loop.attempt?.launch ?? { key: loop.attempt?.key } : ref;
  if ((retained && retained !== recovery) || !["loop-plan", "attempt-result", "interrupted-operation", "checkpoint"].includes(kind) ||
      (recovery && (!same(recovery.association, association(loop.number)) ||
      recovery.phase !== kind || !same(recovery.source, ref) || !text(recovery.ref?.key) ||
      !["intention", "observed"].includes(recovery.stage))) ||
      !text(ref?.key) || producer?.key !== ref.key ||
      (producer?.runId && ref.runId && producer.runId !== ref.runId))
    return Promise.reject(new Error("Recovery association/stage conflict; retained unchanged."));
  if (!recovery) {
    recovery = { subject, phase: kind, association: association(loop.number),
      source: clone(ref), ref: { key: `${key}.l${loop.number}.recover${loop.recoveries.length + 1}` },
      stage: "intention", disposition: "pending" };
    loop.recoveries.push(recovery);
  }
  const recoveryKey = recovery.ref.key;
  const recoveryRunId = recovery.ref.runId;
  // Persist intent before the external query. An uncertain launch is reconciled
  // by status only: repeating runs.all with the same key is not reattachment.
  return (existing ? observeStatus(recovery.ref.runId ?? recoveryKey).then(result => {
    if ((recoveryRunId && result?.runId && result.runId !== recoveryRunId) ||
        (result?.agent && result.agent !== "pitako.execution-inspector") ||
        (result?.key && result.key !== recoveryKey && result.key !== recoveryRunId))
      throw new Error("Recovery producer/run identity conflict.");
    const cause = barrier(result, recovery.ref.runId ?? recoveryKey);
    if (cause) throw nativeBarrier(cause);
    return retainedReadOnlyOriginal(result, recovery.ref);
  }) : save().then(() =>
    collect(recoveryKey, "pitako.execution-inspector",
    { label: kind === "attempt-result" ? "Recover implementation result" : kind === "checkpoint" ? "Recover writer checkpoint"
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
For attempt-result recovery return the exact original full workerResult only when actually retained and settled;
otherwise unresolved. Report exact provenance and availability. Do not infer settlement from missing inventory.
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
  const ref = loop.plan.ref;
  return observeStatus(ref.runId ?? ref.key).then(result => {
    if (barrier(result, ref.runId ?? ref.key)) throw nativeBarrier(barrier(result, ref.runId ?? ref.key), ref);
    // Status that actually contains the original full value is usable, unlike management previews.
    const original = result?.structuredOutput;
    if ((ref.agent && ref.agent !== "pitako.execution-director") ||
        (result?.agent && result.agent !== "pitako.execution-director") ||
        (ref.runId && result?.runId && result.runId !== ref.runId))
      planConflict("loop_plan producer/run identity conflict.");
    if (original && text(result.runId) && (!ref.runId || result.runId === ref.runId)) {
      planAuthority(original, result);
      if (activePlan && !same(activePlan, original)) planConflict("Conflicting complete loop_plan values.");
      activePlan = original;
      loop.plan.ref = nativeReference(ref.key, result);
      // No model recovery when both actual complete values are directly present.
      if (text(result.output) && /^[\s]*\{/.test(result.output)) {
        let binding;
        try { binding = JSON.parse(result.output); } catch (_) { planConflict("Invalid complete loop_plan binding JSON."); }
        if (!same(binding, original)) planConflict("Changed/conflicting loop_plan binding; no edits authorized.");
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
        observed.comparison === "different-full-json") planConflict("Changed/conflicting loop_plan binding; no edits authorized.");
    // Unresolved observation is a current impediment, not proof of full loss.
    // Preserve its concrete explanation for every caller, including replay.
    if (observed.status === "unresolved")
      throw new Error(`Plan recovery unresolved: ${observed.reason}`);
    if (observed.originalAvailable && observed.original) {
      planAuthority(observed.original);
      if (activePlan && !same(activePlan, observed.original)) planConflict("Conflicting complete loop_plan values.");
      activePlan = observed.original;
      loop.plan.recoverySource = { ref: loop.recoveries[loop.recoveries.length - 1].ref,
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
// Checkpoint-backed pending units restore first. Legacy attempts without real
// modifying checkpoint intentions retain their exact native continuation route.
function continueAttempt(observed, ref, task, prerequisites) {
  const descriptor = loop.attempt;
  const cause = barrier(observed, ref.runId ?? ref.key);
  if (pendingCheckpointUnit()) assertFallbackProducer(observed, ref);
  else if (cause && cause !== "interrupted") throw nativeBarrier(cause);
  if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
      (observed?.agent && observed.agent !== "pitako.worker"))
    throw new Error("Worker producer/run identity conflicts with frozen attempt.");
  if (pendingCheckpointUnit()) {
    const successor = descriptor.nativeContinuation &&
      (descriptor.nativeContinuation.ref ?? { key: descriptor.nativeContinuation.key });
    if (successor) return observeStatus(successor.runId ?? successor.key, true).then(current => {
      assertFallbackProducer(current, successor);
      if (current?.ok && current.structuredOutput && text(current.runId)) return current;
      return checkpointFallback(current, successor, task);
    });
    return checkpointFallback(observed, ref, task);
  }
  let continuation = descriptor.nativeContinuation;
  if (!continuation) {
    const runId = observed?.runId ?? ref.runId;
    if (!text(runId)) throw new Error("Exact interrupted writer run ID unavailable; no replacement writer authorized.");
    continuation = descriptor.nativeContinuation = {
      stage: "intention", source: clone({ ...ref, runId }), ref: { key: `${descriptor.key}.resume` },
    };
    return save().then(() => collect(continuation.ref.key, "pitako.worker",
      { label: task.goal, phase: "implementation" }, `${fullContext()}
CONTINUE THE EXACT INTERRUPTED ATTEMPT through the public native resume operation.
No new task, loop or permission. Preserve prior WIP and the admitted task/check contracts.
Do not infer a pass from partial logs; finish missing work and execute required checks
against the actual candidate. Load and apply verify-behavior before claiming completion.
COMPLETE SHARED CONTEXT:\n${JSON.stringify(activePlan.sharedContext)}
DIRECT PREREQUISITE COMPLETED RESULTS (historical references): ${JSON.stringify(prerequisites)}
COMPLETE SELECTED TASK:\n${JSON.stringify(task)}
FROZEN ATTEMPT:\n${JSON.stringify(descriptor)}
RETAINED LEGACY ATTEMPT: no checkpoint intention was admitted for this native resume.
Preserve its original contract; do not invent a checkpoint binding, intention or backup.
New checkpoint-backed same-task continuations use checkpoint_create in a fresh bound writer;
this legacy resume does not migrate historical state or manufacture captured bytes.
ORIGINAL COMPLETE PLAN REFERENCES: ${JSON.stringify(loop.plan.ref)}
Original interrupted producer: ${JSON.stringify(continuation.source)}
Return the complete worker structured_output contract with actual evidence for EVERY planned check.
No private diary/progress files, commits, publication, delegation or next-task selection.`,
      workerSchema, true, dispatch, runId)).then(result => {
        continuation.ref = nativeReference(continuation.ref.key, result);
        continuation.stage = "receipt";
        // Save the successor reference before interpreting its semantic result.
        return save().then(() => {
          const cause = barrier(result);
          if (cause) throw nativeBarrier(cause);
          if (!result?.ok || !text(result.runId) || !result.structuredOutput)
            throw new Error(`Native attempt continuation has no complete result: ${result?.error ?? result?.output ?? "unknown"}; retain exact operation, no replacement writer authorized.`);
          return result;
        });
      });
  }
  if (!text(continuation.source?.runId) || continuation.source.key !== descriptor.key ||
      continuation.ref?.key !== `${descriptor.key}.resume` ||
      (descriptor.launch?.runId && continuation.source.runId !== descriptor.launch.runId) ||
      !["intention", "receipt"].includes(continuation.stage))
    throw new Error("Interrupted attempt continuation association conflicts; retained unchanged.");
  return observeStatus(continuation.ref.runId ?? continuation.ref.key).then(result => {
    const pending = barrier(result, continuation.ref.runId ?? continuation.ref.key);
    if (pending) throw nativeBarrier(pending);
    if (!result?.ok || !text(result.runId) || !result.structuredOutput ||
        (continuation.ref.runId && continuation.ref.runId !== result.runId))
      throw new Error("Native attempt continuation remains unresolved; no duplicate resume or replacement writer authorized.");
    continuation.ref = nativeReference(continuation.ref.key, result);
    continuation.stage = "receipt";
    return save().then(() => result);
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
  const historicalStop = cause === "stopped" && ["accepted", "applied"].includes(resolution?.stage) &&
    !resolution.currentBarrier && resolution.halt?.cause === "stopped" &&
    resolution.operations?.some(item => item.key === ref.key && item.runId === ref.runId);
  if (cause && cause !== "interrupted" && !historicalStop) throw nativeBarrier(cause, ref);
  if ((observed?.runId && ref.runId && observed.runId !== ref.runId) ||
      (observed?.agent && observed.agent !== "pitako.worker"))
    throw new Error("Worker producer/run identity conflicts with frozen attempt.");
}
function confirmedUnitForPending() {
  const point = loop.confirmedCheckpoint;
  if (point?.kind !== "unit") return undefined;
  const { taskId, attempt, resultRef, ...receipt } = point;
  const result = loop.results.find(item => item.taskId === taskId && item.attempt === attempt && same(item.ref, resultRef));
  if (!result || result.status !== "complete" || !same(result.checkpoint?.confirmation, receipt) ||
      !same(point.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
      receipt.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${result.checkpoint.key}/unit.json`)
    throw new Error("Confirmed unit conflicts with admitted pending progress.");
  return clone(point);
}
function checkpointFallback(observed, ref, task) {
  const descriptor = loop.attempt;
  assertFallbackProducer(observed, ref);
  if (!descriptor.checkpoint || loop.results.some(result => result.taskId === task.id && result.status === "complete"))
    throw new Error("Checkpoint fallback cannot restore a completed task or missing checkpoint.");
  const witness = checkpointObservation;
  if (witness && (witness.key !== descriptor.key || witness.taskId !== task.id || witness.attempt !== descriptor.number ||
      witness.loop !== loop.number || witness.cursor !== loop.cursor))
    throw new Error("Checkpoint observation conflicts with pending unit.");
  if (witness?.error) throw new Error(`Checkpoint observation unavailable: ${witness.error}`);
  const evidence = witness?.evidence ?? null;
  // A restoration intention consumes this material witness durably, before
  // dispatch. Reentry reconciles that exact operation first; fresh status,
  // renamed keys and equivalent captures cannot renew its modifying route.
  const prior = [descriptor, ...(loop.interruptions ?? [])].filter(item =>
    item.taskId === task.id && item.index === loop.cursor && item.restore);
  const pauseRestoration = loop.confirmedCheckpoint?.kind === "pause" ||
    loop.results.some(item => item.taskId === task.id && item.checkpoint?.confirmation?.kind === "pause") ||
    prior.some(item => item.restore.authority?.confirmedPause);
  if (pauseRestoration) {
    const { taskId, attempt, resultRef, ...receipt } = loop.confirmedCheckpoint ?? {};
    const result = loop.results.find(item => item.taskId === taskId && item.attempt === attempt && same(item.ref, resultRef));
    if (taskId !== task.id || !["blocked", "continue", "gaps"].includes(result?.status) || !(result.remainingCount > 0) ||
        receipt.kind !== "pause" || !same(receipt, result.checkpoint?.confirmation) ||
        !same(receipt.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
        receipt.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${result.checkpoint.key}/pause.json` ||
        prior.some(item => {
          // Each retained operation consumed the pause admitted BEFORE that
          // operation, not a newer pause its worker may legitimately publish.
          const source = loop.results.filter(entry => entry.taskId === task.id && entry.attempt < item.number &&
            entry.checkpoint?.confirmation?.kind === "pause").at(-1);
          const authority = item.restore.authority?.confirmedPause;
          return source ? !["blocked", "continue", "gaps"].includes(source.status) || !(source.remainingCount > 0) ||
            !same(authority, source.checkpoint.confirmation) ||
            !same(authority.position, receipt.position) ||
            authority.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${source.checkpoint.key}/pause.json`
            : !!authority;
        }))
      throw new Error("Confirmed pause conflicts with admitted pending progress or retained restoration authority.");
  }
  // An old pause's missing witness is not a baseline for newly visible files.
  // Reconcile the exact operation/result without inventing its original evidence.
  // Non-pause recovery retains its existing material-progress routes.
  if (descriptor.restore && (!evidence || prior.some(item => item.restore.evidence === evidence ||
      pauseRestoration && !item.restore.evidence &&
        same(item.restore.authority?.confirmedPause, descriptor.result?.checkpoint?.confirmation ?? descriptor.restore.authority?.confirmedPause)))) {
    const error = new Error("Restoration remains pending with no new checkpoint evidence; reconcile the exact operation or supply material progress, no replacement writer authorized.");
    error.nativeFailure = { code: "recovery", reason: error.message, ref: clone(ref) };
    throw error;
  }
  checkpointObservation = undefined;
  const manifest = `${config.root}/.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json`;
  // The modifying worker reads and validates these exact bytes through the owned
  // helper before any effect. No model inspector/result rescue is a prerequisite.
  const checkpoint = { key: descriptor.checkpoint.key, manifest };
  const sources = [clone(descriptor.checkpoint),
    ...[].concat(descriptor.restore?.checkpoint ?? [])];
  const confirmedUnit = descriptor.restore?.authority?.confirmedUnit ?? confirmedUnitForPending();
  const observations = sources.map(source => ({ key: source.key,
    manifest: `${config.root}/.pi/subagents/checkpoints/${source.key}/manifest.json` }));
  if (confirmedUnit) observations.push({ key: confirmedUnit.checkpointRef.split("/").at(-2),
    manifest: confirmedUnit.checkpointRef.replace(/unit\.json$/, "manifest.json") });
  descriptor.fallback = { stage: "admitted", source: clone(ref),
    observation: observed === undefined ? { state: "unknown", reason: "Public writer status unavailable" } : clone(observed),
    checkpoint: clone(checkpoint) };
  loop.interruptions ??= [];
  loop.interruptions.push(clone(descriptor));
  loop.attempt = { taskId: task.id, index: loop.cursor, number: descriptor.number + 1,
    key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${descriptor.number + 1}`, stage: "intention",
    continuationRef: descriptor.result?.ref ?? null, restore: { undispatched: true,
      checkpoint: sources.length === 1 ? sources[0] : sources, evidence, observation: checkpoint, observations,
      producer: clone(ref), authority: { pending: true, stop: false, permissionDenied: false,
        activeWriter: null, references: [ref.runId ?? ref.key, manifest],
        ...(confirmedUnit ? { confirmedUnit } : {}),
        ...(descriptor.restore?.authority?.confirmedPause ? { confirmedPause: clone(descriptor.restore.authority.confirmedPause) } : {}),
        ...(descriptor.result?.checkpoint?.confirmation?.kind === "pause"
          ? { confirmedPause: clone(descriptor.result.checkpoint.confirmation) } : {}) } } };
  // Essential admission of the restoration intention precedes modifying dispatch.
  return save().then(() => null);
}
function workerValue(result, descriptor, task, statusRef) {
  const value = result?.structuredOutput;
  if ((result?.agent !== undefined && result.agent !== "pitako.worker") ||
      // A status response may echo its exact queried run ID as key. That is
      // transport association, not a different producer dispatch key.
      (result?.key !== undefined && result.key !== descriptor.key && result.key !== statusRef && result.key !== descriptor.nativeContinuation?.ref.key && result.key !== descriptor.nativeContinuation?.ref.runId) ||
      ((descriptor.nativeContinuation?.ref.runId ?? descriptor.launch?.runId) &&
        result?.runId !== (descriptor.nativeContinuation?.ref.runId ?? descriptor.launch?.runId)) ||
      (Array.isArray(result?.results) && result.results.some(entry =>
        (entry.agent !== undefined && entry.agent !== "pitako.worker") ||
        (entry.exitCode !== undefined && entry.exitCode !== 0))))
    throw new Error("Worker producer/run identity conflicts with frozen attempt.");
  if (text(result?.output) && /^[\s]*\{/.test(result.output)) {
    let binding;
    try { binding = JSON.parse(result.output); } catch (_) { throw new Error("Invalid complete worker binding JSON."); }
    if (!same(binding, value)) throw new Error("Changed/conflicting worker binding.");
  }
  if (!result?.ok || !value || value.taskId !== descriptor.taskId || value.attempt !== descriptor.number ||
      !["complete", "continue", "gaps", "blocked"].includes(value.status) ||
      !text(value.workDone) || !text(value.diagnosis) || !Array.isArray(value.remaining) ||
      !value.remaining.every(text) || typeof value.usefulProgress !== "boolean" ||
      !(value.continuation === null || text(value.continuation)) ||
      !text(value.git?.head) || !text(value.git?.wip) || !Array.isArray(value.git.checkpoints) ||
      !value.git.checkpoints.every(text))
    throw new Error("Worker returned no complete task/attempt/progress/diagnosis/Git contract.");
  if (descriptor.restore && value.status !== "blocked") {
    const receipt = value.restoreReceipt;
    const observation = (descriptor.restore.observations ?? [descriptor.restore.observation])
      .find(item => item.manifest === receipt?.checkpointRef);
    if (!receipt || !observation || receipt.checkpointRef !== observation.manifest ||
        !/^[a-f0-9]{64}$/.test(receipt.digest ?? "") || (observation.digest && receipt.digest !== observation.digest) ||
        receipt.partialRef !== observation.manifest.replace(/manifest\.json$/, "restore.json") ||
        receipt.restoredRef !== observation.manifest.replace(/manifest\.json$/, "restored.json") ||
        !same(receipt.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
        !value.git.checkpoints.includes(receipt.partialRef) || !value.git.checkpoints.includes(receipt.restoredRef))
      throw new Error("Fallback worker lacks complete actual restoration evidence; no result admitted.");
    const pause = descriptor.restore.authority?.confirmedPause;
    if (pause && pause.checkpointRef === observation.manifest.replace(/manifest\.json$/, "pause.json") &&
        !same(receipt.confirmedPause, { checkpointRef: pause.checkpointRef, digest: pause.digest }))
      throw new Error("Fallback result lacks exact confirmed pause baseline evidence.");
    const unit = descriptor.restore.authority?.confirmedUnit;
    if (unit && unit.checkpointRef === observation.manifest.replace(/manifest\.json$/, "unit.json") &&
        !same(receipt.confirmedUnit, { checkpointRef: unit.checkpointRef, digest: unit.digest }))
      throw new Error("Fallback result lacks exact confirmed unit baseline evidence.");
    candidate(receipt.candidate);
  }
  candidate(value.candidate);
  // Presence of progress versions new modifying intentions. Retained pre-contract
  // intentions remain readable, but cannot imply bytes that were never captured.
  if (task.kind === "implementation" && descriptor.checkpoint?.progress &&
      value.status === "complete" && !value.checkpointReceipt)
    throw new Error("New implementation unit lacks required sealed file/progress checkpoint.");
  if (value.checkpointReceipt) {
    const receipt = value.checkpointReceipt, intent = descriptor.checkpoint;
    const complete = receipt.kind === "unit";
    if (receipt.kind === "pause" && !value.remaining.length) {
      const reason = "Pause checkpoint contradicts missing pending work; no continuation point admitted.";
      loop.halt = { status: "blocked", code: "semantic-block", reason, ref: clone(descriptor.launch ?? { key: descriptor.key }) };
      throw new Error(reason);
    }
    if (!intent?.progress || !["unit", "pause"].includes(receipt.kind) ||
        complete !== (value.status === "complete") ||
        receipt.checkpointRef !== `${config.root}/.pi/subagents/checkpoints/${intent.key}/${receipt.kind}.json` ||
        !/^[a-f0-9]{64}$/.test(receipt.digest ?? "") ||
        !same(receipt.candidate, value.candidate) || !same(receipt.progress, intent.progress) ||
        !same(receipt.position, { loop: loop.number, cursor: loop.cursor + (complete ? 1 : 0), phase: "implementation" }) ||
        !value.git.checkpoints.includes(receipt.checkpointRef))
      throw new Error("Checkpoint seal does not match admitted unit/pending progress.");
  }
  if (value.git.head !== value.candidate.head || !Array.isArray(value.checks) ||
      new Set(value.checks.map(check => check?.id)).size !== value.checks.length ||
      task.checks.some(required => !value.checks.some(check => check?.id === required.id)))
    throw new Error("Worker result lacks planned check evidence or has duplicate check IDs.");
  // Validate the whole report before aggregation, including entries after a failed check.
  const checks = value.checks.map(check => {
    const definition = task.checks.find(entry => entry.id === check?.id);
    if (!text(check?.id) || !text(check.command) || !text(check.cwd) ||
        (definition && !["command", "cwd"].every(field => check[field] === definition[field])) ||
        (check.requirement !== undefined && !text(check.requirement)) ||
        !text(check.output) || !Array.isArray(check.logPaths) ||
        !check.logPaths.every(text) ||
        !["passed", "failed", "not-run"].includes(check.result))
      throw new Error("Check command/cwd/output/result differs from loop_plan.");
    // Only planned checks attest to the candidate. Diagnostic identities may be
    // unknown or non-verifiable; preserve them without normalization.
    return definition ? { ...check, requirement: definition.requirement,
      before: candidate(check.before), after: candidate(check.after) } : { ...check };
  });
  // Historical diagnostics retain their evidence without becoming new mandatory gates.
  const checksCurrent = checks.filter(check => task.checks.some(required => required.id === check.id))
    .every(check => check.result === "passed" &&
      same(check.before, check.after) && same(check.after, value.candidate));
  if (value.status === "complete" && (!checksCurrent || value.remaining.length))
    throw new Error("Task complete contradicts current mandatory checks or pending work.");
  return { value, checks, checksCurrent };
}
function admitWorker(result, descriptor, task, recoveryRef, statusRef) {
  const parsed = workerValue(result, descriptor, task, statusRef);
  const value = parsed.value;
  const projected = { ...projection(descriptor.key, result), taskId: descriptor.taskId,
    attempt: descriptor.number, candidate: candidate(value.candidate),
    ...(descriptor.checkpoint ? { checkpoint: {
      key: descriptor.checkpoint.key, manifest: `.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json`,
    } } : {}),
    ...(descriptor.restore ? { restore: { observation: descriptor.restore.observation,
      receipt: value.restoreReceipt ?? null, producer: descriptor.restore.producer } } : {}),
    workDone: excerpt(value.workDone), diagnosis: excerpt(value.diagnosis),
    remaining: value.remaining.slice(0, 4).map(excerpt), remainingCount: value.remaining.length,
    checks: { current: parsed.checksCurrent, count: parsed.checks.length,
      passed: parsed.checks.filter(check => check.result === "passed").length,
      failed: parsed.checks.filter(check => check.result === "failed").length,
      notRun: parsed.checks.filter(check => check.result === "not-run").length },
    usefulContinuation: value.status === "continue" && value.usefulProgress &&
      value.remaining.length > 0 && text(value.continuation) && text(value.diagnosis),
    continuationIdentity: continuationIdentity(value),
  };
  if (descriptor.nativeContinuation) projected.ref = { ...descriptor.nativeContinuation.ref,
    resumedFrom: descriptor.nativeContinuation.source };
  if (recoveryRef) projected.ref = { ...projected.ref, ...descriptor.launch,
    recovery: { ref: recoveryRef, field: "structuredOutput.workerResult" } };
  if (loop.results.some(previous => previous.taskId === descriptor.taskId &&
      previous.continuationIdentity === projected.continuationIdentity))
    projected.usefulContinuation = false;
  // The seal is not confirmed until this result and pointer are saved together.
  // A failed essential save leaves the previous durable point authoritative.
  if (value.checkpointReceipt) {
    projected.checkpoint.confirmation = clone(value.checkpointReceipt);
    loop.confirmedCheckpoint = { ...clone(value.checkpointReceipt), taskId: descriptor.taskId,
      attempt: descriptor.number, resultRef: clone(projected.ref) };
  }
  loop.results.push(projected);
  loop.attempt.result = projected;
  loop.attempt.stage = "result";
  if (["recovery", "native-barrier"].includes(loop.halt?.code)) delete loop.halt;
  if (projected.status === "blocked" || confirmedPausePending()) retainWorkerBlock(projected);
  currentCandidate = projected.candidate;
  return parsed.value;
}
function confirmedPausePending() {
  const result = loop?.attempt?.stage === "result" && loop.attempt.result;
  const { taskId, attempt, resultRef, ...receipt } = loop?.confirmedCheckpoint ?? {};
  return loop?.phase === "implementation" && ["blocked", "continue", "gaps"].includes(result?.status) && result.remainingCount > 0 &&
    result.checkpoint?.confirmation?.kind === "pause" && taskId === result.taskId && attempt === result.attempt &&
    same(resultRef, result.ref) && same(receipt, result.checkpoint.confirmation);
}
function retainWorkerBlock(result) {
  loop.outcome = "blocked";
  loop.halt = { status: "blocked", code: "semantic-block", reason: result.diagnosis, ref: result.ref };
}
function loopReport(status, reason) {
  const now = Date.now();
  const last = loop.results[loop.results.length - 1];
  const stale = !!loop.invalidated || loop.closing?.sameCandidate === false;
  if (persistenceFailed && persistenceReason && !reason.includes(persistenceReason)) reason += ` ${persistenceReason}`;
  const exhausted = !persistenceFailed && !loop.halt && status === "gaps" && invocation.loops.length >= maxCycles();
  if (!persistenceFailed && !loop.halt && status === "gaps" && !exhausted && !config.inspections[loop.number + 1]) {
    loop.halt = hostCapacityHalt();
    status = "partial"; reason = loop.halt.reason;
  }
  if (exhausted) reason = `${maxCycles()} authorized loops consumed; execution partial. Remaining work requires a new invocation with human authorization.` +
    (stale ? " Candidate changed; affected checks and analyses are stale." : "");
  const report = {
    type: "execution-loop", invocation: config.invocation, loop: loop.number, maxLoops: maxCycles(),
    status: exhausted ? "partial" : status, reason, phase: loop.phase, candidate: loop.closing?.candidate ?? last?.candidate ?? null,
    halt: loop.halt ?? null,
    elapsedMs: (loop.endedAt ?? now) - loop.startedAt, totalElapsedMs: now - invocation.startedAt,
    tokens: metrics(loop), totalTokens: metrics(),
    work: loop.results.map(result => ({ taskId: result.taskId, attempt: result.attempt,
      status: result.status, reference: result.ref, workDone: result.workDone ?? "See native failure result",
      remaining: result.remaining ?? [], remainingCount: result.remainingCount ?? null,
      diagnosis: result.diagnosis ?? "See native failure result" })),
    verification: {
      checks: loop.results.filter(result => result.checks).map(result => ({
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
    next: loop.halt ? (persistenceFailed ? "restore essential persistence; resolve observed impediment before any continuation" : "resolve observed impediment") : persistenceFailed ? "restore essential persistence; continuation requires supported native reconciliation" : status === "complete" ? "close" : status === "gaps" && invocation.loops.length < maxCycles()
      ? `continue loop ${loop.number + 1}` : status === "gaps" ? "new invocation requires human authorization" : "resolve observed impediment",
    actionRequired: !persistenceFailed && !loop.halt && (status === "complete" || (status === "gaps" && invocation.loops.length < maxCycles())) ? "none" : reason,
    action: action(exhausted ? "partial" : status, reason),
  };
  if (typeof emit === "function") emit(report);
  return report;
}
function action(status, reason) {
  const required = status !== "complete";
  const exhausted = !persistenceFailed && !loop?.halt && status === "partial" &&
    invocation?.loops?.length >= maxCycles();
  const decision = loop?.plan?.status === "needs-decision";
  return {
    actor: !required ? "none" : persistenceFailed ? "persistence operator" : decision || exhausted ? "human"
      : hostHalt ? "native run operator"
      : loop?.halt?.code === "recovery" ? "evidence owner"
      : loop?.halt?.code === "semantic-block" ? "task owner"
      : loop?.halt ? "native run operator" : "active root",
    operation: !required ? "close" : persistenceFailed ? "restore essential persistence; no dispatch authorized"
      : hostHalt ? "reconcile the retained host observation through bounded read-only reconstruction under native policy; observed barriers still govern effects"
      : decision ? "answer the retained product decision" : exhausted ? "authorize a new invocation"
      : loop?.halt ? "resolve the concrete retained impediment; no replacement dispatch"
      : "perform the next existing phase under native authority",
    reason, references: [hostHalt?.ref, resolution?.currentBarrier?.ref, loop?.halt?.ref, loop?.recoveries?.at(-1)?.ref,
      loop?.attempt?.launch, loop?.plan?.ref, ...(loop?.analysisCalls ?? []).map(call => call.ref)].filter(Boolean),
    // This describes pending work, not a claim that a root was resumed.
    started: false,
  };
}
function finish(status, reason) {
  if (persistenceFailed && persistenceReason && !reason.includes(persistenceReason)) reason += ` ${persistenceReason}`;
  return {
    status, heading: `Execution ${status}`, reason, invocation: config.invocation,
    missionId: config.missionId, missionPath: config.missionPath,
    loopsConsumed: invocation?.loops?.length ?? 0, maxLoops: maxCycles(),
    elapsedMs: Number.isFinite(invocation?.startedAt) ? Date.now() - invocation.startedAt : null, tokens: metrics(),
    phase: loop?.phase ?? "admission", candidate: loop?.closing?.candidate ?? currentCandidate ?? null,
    loopReport: loop ? loopReport(status === "partial" && loop.outcome === "gaps" && !persistenceFailed ? "gaps" : status, reason) : null,
    actionRequired: status === "complete" ? "none" : reason,
    action: action(status, reason),
    publication: "not performed by workflow", references,
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
  activePlan = invocation?.activePlan;
  loop = invocation?.loops?.at(-1);
  // Validate the stored request before even read-only reconstruction. Snapshot
  // equality is checked against the inspector below, never repaired from input.
  if (invocation?.association) {
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
  if ((invocation && ![2, 3].includes(invocation.version)) || (legacy && ![2, 3].includes(legacy.version)))
    return finish("blocked", "Obsolete execute supervisor state cannot be replayed or migrated; retained unchanged.");
  if (legacy && (legacy.version !== invocation?.version || !same(legacy.association, invocation?.association) ||
      legacy.association.invocation !== config.invocation))
    return finish("blocked", "Native mission already belongs to another immutable invocation; no replacement writer dispatched.");
  if (!config.unblock) {
    // A durable human input survives technical replay without another flag.
    // Matching its original observation does not settle subsequent intentions.
    const retained = [...(invocation?.resolutions ?? []),
      ...(invocation?.loops ?? []).flatMap(item => item.resolutions ?? [])];
    if (retained.some(item => !same(item.request, hostRequest())))
      return finish("blocked", "Retained continuation input association conflicts; retained unchanged.");
    // Keep the latest disposition, including a later native barrier. Falling
    // back to an older successful input could otherwise revive its authority.
    resolution = retained.reverse().find(item => same(item.request, hostRequest()));
  }
  if (config.unblock) {
    const target = config.resolution.loop === 0 ? invocation : invocation?.loops?.find(item => item.number === config.resolution.loop);
    const existing = target?.resolutions?.find(item => item.text === config.resolution.text && item.loop === config.resolution.loop);
    if (!target || (!existing && (config.resolution.loop !== (loop?.number ?? 0) ||
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
      return finish("blocked", "Bounded host reconstruction is unresolved or failed; retain the exact operation, no replacement inspection authorized.");
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
  if (text(current.error)) throw new Error(current.error);
  if (!current.selected) return finish("blocked", "Select complete unambiguous specs with the packaged inspector.");
  let metadata = current;
  if (!invocation?.association) {
    const requestState = invocation;
    // Older already-running resource scripts may still have a separate grant.
    // New registrations coalesce these authorized reads in the initial receipt.
    const admitted = current.admission ?? (config.settings ? await host(config.settings) : {});
    if (text(admitted.error)) throw new Error(admitted.error);
    if (!Number.isSafeInteger(admitted.maxCycles) || admitted.maxCycles < 1)
      throw new Error("Invalid pitako.execute.maxCycles admission receipt.");
    const captured = await capture(current);
    metadata = captured.metadata;
    invocation = {
      version: 3, association: { missionId: config.missionId, missionPath: config.missionPath,
        invocation: config.invocation, root: metadata.root, commonDir: metadata.commonDir,
        source: metadata.selected.source, digest: metadata.selected.digest,
        maxCycles: admitted.maxCycles, sourceRefs: config.sourceRefs ?? [] },
      snapshot: { content: captured.content }, startedAt: Date.now(), loops: [], activePlan: null,
      ...(requestState?.hostHalt ? { hostHalt: requestState.hostHalt } : {}),
      ...(requestState?.resolutions ? { resolutions: requestState.resolutions } : {}),
      ...(requestState?.hostReconstruction ? { hostReconstruction: requestState.hostReconstruction } : {}),
    };
    if (metadata.root !== config.root) throw new Error("Designated worktree mismatch.");
    await save();
  } else {
    replay = true;
    if (invocation.version === 3 && (!Number.isSafeInteger(invocation.association?.maxCycles) ||
        invocation.association.maxCycles < 1 || !same(invocation.association.sourceRefs, config.sourceRefs ?? [])))
      throw new Error("Incompatible immutable maxCycles/sourceRefs association; retained unchanged.");
    if (invocation.version === 2 && ((config.sourceRefs ?? []).length || invocation.association?.maxCycles !== undefined))
      throw new Error("Legacy fixed-three association cannot acquire configuration or source references.");
    if (current.transport) {
      const captured = await capture(current);
      metadata = captured.metadata;
      if (captured.content !== invocation.snapshot.content)
        throw new Error("Immutable full snapshot content changed; retained unchanged.");
    }
    const observed = metadata.selected;
    const expected = invocation.association;
    if (expected.missionId !== config.missionId || expected.missionPath !== config.missionPath ||
        expected.invocation !== config.invocation || expected.root !== config.root ||
        observed.digest !== expected.digest ||
        metadata.root !== expected.root || metadata.commonDir !== expected.commonDir || observed.source !== expected.source)
      return finish("blocked", "Immutable mission/invocation/snapshot/worktree association changed; retained unchanged.");
    activePlan = invocation.activePlan;
    invocation.activePlan = null;
  }
  if (invocation.version === 3) {
    associationSchema.properties.maxCycles = integer;
    associationSchema.properties.sourceRefs = list(object({ path: string, digest: string }));
    associationSchema.required.push("maxCycles", "sourceRefs");
  }
  if (!legacy) {
    try { await state.set("pitako-execution", { version: invocation.version, association: invocation.association }); }
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
  loop = invocation.loops[invocation.loops.length - 1];
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
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && !confirmedPausePending())
    await reconcileRetainedRecoveries();
  // A completed needs-decision producer is not redispatched. Current useful
  // input goes to the next ordinary budgeted loop; retain its question/ref.
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number &&
      loop.plan?.status === "needs-decision" && loop.outcome === "blocked") {
    resolution.stage = "applied";
    loop.outcome = "gaps";
    delete loop.halt;
    await save();
  }
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number &&
      loop.halt?.code === "native-barrier" && !confirmedPausePending() &&
      ["stopped", "interrupted", "native permission denial"].includes(loop.halt.cause))
    await reconcileInterruptedOperations();
  if (resolution?.stage === "accepted" && resolution.hostHalt && !loop?.halt) {
    // The bounded reconstruction is applied, not a claim that a historical
    // host receipt or a later writer has settled.
    resolution.stage = "applied";
    await save();
  }
  // Only an admitted cooperative pause with pending work consumes current input.
  // A checkpoint alone does not resolve an unrelated semantic/product impediment.
  const paused = loop?.attempt?.stage === "result" && loop.attempt.result;
  if (resolution?.stage === "accepted" && resolution.loop === loop?.number && confirmedPausePending() &&
      same(resolution.halt, loop.halt) && (loop.halt?.code === "semantic-block" ||
        (loop.halt?.code === "native-barrier" && ["stopped", "interrupted"].includes(loop.halt.cause)))) {
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
  // Recover the old result-committed/outcome-not-committed cut before plan recovery.
  if (loop?.attempt?.stage === "result" && (loop.attempt.result?.status === "blocked" || confirmedPausePending()) &&
      (!loop.halt || loop.halt.code === "semantic-block"))
    retainWorkerBlock(loop.attempt.result);
  // Historical read-only parser rejection is re-evaluated from exact originals,
  // not a new authorization or an extra implementation slot.
  if (loop?.halt?.code === "semantic-block" && ["review", "compliance"].includes(loop.phase)) {
    delete loop.halt;
    delete loop.outcome;
    await save();
  }
  // This is our registration's pre-dispatch observation, not a native denial.
  // Preserve history, then reevaluate only the missing next closing grant.
  if (same(loop?.halt, hostCapacityHalt()) &&
      loop.outcome === "gaps" && invocation.loops.length < maxCycles() &&
      config.inspections[invocation.loops.length + 1]) {
    (loop.capacityHistory ??= []).push(clone(loop.halt));
    delete loop.halt;
    await save();
  }
  if (["capacity", "native-dispatch", "semantic-block"].includes(loop?.halt?.code))
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
  while (true) {
    if (!loop || loop.outcome) {
      if (invocation.loops.length >= maxCycles()) return finish("partial", `${maxCycles()} authorized loops consumed; remaining work requires new human authorization.`);
      if (!config.inspections[invocation.loops.length + 1]) {
        const cause = hostCapacityHalt();
        if (loop) { loop.halt = cause; await save(); }
        return finish("partial", cause.reason);
      }
      activePlan = null;
      loop = { number: invocation.loops.length + 1, startedAt: Date.now(), phase: "director",
        cursor: 0, manifest: null, plan: null, attempt: null, results: [], recoveries: [], usage: [] };
      invocation.loops.push(loop);
      // Slot is consumed durably BEFORE calling a fresh read-only director.
      await save();
    }
    associationSchema.const = association(loop.number);
    if (loop.phase === "director") {
      const directorKey = `${key}.l${loop.number}.director`;
      if (!loop.plan) {
        loop.plan = { stage: "intention", ref: { key: directorKey } };
        await save();
        const result = await collect(directorKey, "pitako.execution-director",
          { label: "Plan execution work", phase: "planning" }, `${fullContext()}
READ-ONLY PLANNING ONLY. Do not delegate, implement, run checks/review, select workers,
maintain private TODOs or supervise execution. Return one COMPLETE loop_plan using structured_output
and the native output binding, then END. Status is plan or needs-decision, never implementation complete.
Root owns ordered selection and attempts. Tasks have stable logical IDs, complete scopes, effects,
sources/context, one concrete observable expectedResult and concrete mandatory checks.
Every task includes dependsOn: [{taskId, reason}] for necessary justified earlier prerequisites,
or [] when none. Prefer independent outcomes, not artificial fragments; scope/effects declare
shared resources, not concurrency authority. Include a LAST verification task
for final checks after all writes even when the implementation already exists. Shared context is complete.
No replacement task list elsewhere. Carry the exact association above. Native permissions and Stop apply.`,
          planSchema);
        loop.plan = { ...projection(directorKey, result), stage: "published" };
        if (barrier(result)) throw nativeBarrier(barrier(result));
        // Publication and admission are separate durable cuts.
        await save();
        if (!result?.ok && !text(result?.runId))
          throw new Error("Director failed without an authoritative settled producer reference.");
        activePlan = result?.structuredOutput;
        if (!activePlan && !(await recoverPlan()))
          throw new Error("No authoritative complete new loop_plan survives.");
        planAuthority(activePlan, result?.structuredOutput ? result : undefined);
        // Some boundaries return complete binding content as output; never parse
        // file-only previews or use them as an alternate task definition.
        if (text(result.output) && /^[\s]*\{/.test(result.output)) {
          let binding;
          try { binding = JSON.parse(result.output); } catch (_) { planConflict("Invalid complete loop_plan binding JSON."); }
          if (!same(binding, activePlan)) planConflict("Changed/conflicting loop_plan binding.");
        }
      } else if (!activePlan || replay) {
        replay = false;
        if (!await recoverPlan()) {
          if (loop.plan.ok === false) throw new Error("No authoritative complete new loop_plan survives.");
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          loopReport("gaps", "Original complete loop_plan lost; no task reconstructed from IDs.");
          continue;
        }
      }
      // Establish authority and all available full-value links BEFORE deciding
      // whether a structural defect can consume an ordinary replanning slot.
      planAuthority(activePlan);
      try {
        validatePlan(activePlan, loop.number, loop.manifest);
      } catch (error) {
        const diagnostic = String(error?.message ?? error);
        if (loop.plan.stage === "admitted" || loop.manifest ||
            !/^loop_plan (?:needs full ordered task scopes|dependencies require)/.test(diagnostic))
          throw error;
        if (invocation.loops.some(item => item !== loop && item.plan?.rejection?.diagnostic === diagnostic)) {
          const reason = `No new useful corrective input for repeated plan defect: ${diagnostic}`;
          // This diagnosed route is exhausted, not an unknown/missing payload.
          // Keep its terminal disposition in essential state, independent of
          // the optional full-plan cache and later original availability.
          loop.halt = { status: "blocked", code: "semantic-block", reason, ref: clone(loop.plan.ref) };
          throw new Error(reason);
        }
        const rejection = { diagnostic,
          correction: "Publish a NEW complete plan with full task scopes/checks, final verification last, and dependsOn: [{taskId, reason}] containing only unique necessary earlier IDs with nonblank reasons. Do not repair or reuse the rejected original.",
          ref: clone(loop.plan.ref), recoverySource: loop.plan.recoverySource ?? null };
        // Rejection and its accounted gap are one essential write. A replay of
        // this committed cut advances, never recovers or readmits that plan.
        loop.plan.stage = "rejected";
        loop.plan.rejection = rejection;
        loop.outcome = "gaps"; loop.endedAt = Date.now();
        delete loop.halt;
        activePlan = null;
        await save();
        loopReport("gaps", `New plan rejected before workers: ${diagnostic}`);
        continue;
      }
      loop.plan.status = activePlan.status;
      if (activePlan.status === "needs-decision") {
        loop.halt = { status: "blocked", code: "semantic-block", reason: excerpt(activePlan.reason), ref: loop.plan.ref };
        loop.outcome = "blocked"; await save();
        return finish("blocked", loop.halt.reason);
      }
      loop.manifest = activePlan.tasks.map(task => task.id);
      loop.plan.stage = "admitted";
      loop.phase = "implementation";
      await save();
    }
    if (loop.phase === "implementation") {
      // An unsaved halt still has its exact native writer receipt. Observe that
      // barrier before dispatching even an optional read-only plan inspector.
      let attemptObservation;
      if (replay && loop.attempt && loop.attempt.stage !== "result") {
        const ref = loop.attempt.launch ?? { key: loop.attempt.key };
        attemptObservation = await observeStatus(ref.runId ?? ref.key, !!loop.attempt.checkpoint);
        assertFallbackProducer(attemptObservation, ref);
      }
      // On recovery compare original full values/binding before another edit.
      if (!activePlan || replay) {
        replay = false;
        if (!await recoverPlan()) {
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          loopReport("gaps", "Complete task definition unavailable."); continue;
        }
      }
      while (loop.cursor < loop.manifest.length) {
        const task = activePlan.tasks[loop.cursor];
        const prerequisites = prerequisiteResults(task);
        let value;
        if (loop.attempt?.stage === "result") {
          // Result is committed before cursor movement: do not repeat completed edits.
          const previous = loop.attempt.result;
          if (previous.status === "blocked" || confirmedPausePending()) return finish("blocked", loop.halt.reason);
          if (previous.status === "complete") {
            loop.cursor++; loop.attempt = null; await save(); continue;
          }
          if (!previous.usefulContinuation) break;
          loop.attempt = { taskId: task.id, index: loop.cursor, number: previous.attempt + 1,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${previous.attempt + 1}`,
            stage: "intention", continuationRef: previous.ref };
          await save();
        } else if (loop.attempt && !loop.attempt.restore?.undispatched) {
          // Never call an unresolved writer key as if native reuse were read-only.
          const ref = loop.attempt.launch ?? { key: loop.attempt.key };
          let observed = attemptObservation ?? await observeStatus(ref.runId ?? ref.key);
          attemptObservation = null;
          assertFallbackProducer(observed, ref);
          const cause = barrier(observed, ref.runId ?? ref.key);
          if (pendingCheckpointUnit() && !(observed?.ok && observed.structuredOutput && text(observed.runId)))
            observed = await continueAttempt(observed, ref, task, prerequisites);
          else if (loop.attempt.nativeContinuation || cause === "interrupted")
            observed = await continueAttempt(observed, ref, task, prerequisites);
          if (observed === null) continue; // durable same-task checkpoint fallback intention
          if (barrier(observed)) throw nativeBarrier(barrier(observed));
          if (observed?.runId && observed?.structuredOutput &&
              (!ref.runId || observed.runId === (loop.attempt.nativeContinuation?.ref.runId ?? ref.runId))) {
            admitWorker(observed, loop.attempt, task, undefined, ref.runId ?? ref.key);
          } else {
            if (ref.runId && observed?.runId && observed.runId !== ref.runId)
              throw new Error("Worker producer/run identity conflicts with frozen attempt.");
            if (observed?.runId) loop.attempt.launch = nativeReference(loop.attempt.key, observed);
            const recovered = await inspectRecovery("attempt-result", loop.attempt.launch ?? ref);
            if (recovered.status !== "recovered" || !recovered.workerResult)
              throw new Error(`Unresolved writer dispatch: ${recovered.reason}; no blind reattachment or replacement.`);
            admitWorker({ ...observed, ok: true, runId: loop.attempt.launch?.runId ?? ref.runId,
              structuredOutput: recovered.workerResult }, loop.attempt, task,
              loop.recoveries.find(item => item.subject === `attempt-result:${loop.attempt.taskId}:${loop.attempt.number}`).ref,
              ref.runId ?? ref.key);
          }
          await save(); continue;
        } else if (!loop.attempt) {
          loop.attempt = { taskId: task.id, index: loop.cursor, number: 1,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a1`, stage: "intention", continuationRef: null };
          await save();
        }
        // Essential intention before dispatch; only the writer's published
        // preimages turn this pointer into a recoverable checkpoint.
        if (!loop.attempt.checkpoint) {
          loop.attempt.checkpoint = { version: 1, association: clone(invocation.association),
            key: loop.attempt.key, taskId: task.id, attempt: loop.attempt.number,
            loop: loop.number, cursor: loop.cursor, phase: loop.phase, planRef: clone(loop.plan.ref),
            progress: { consumedLoops: invocation.loops.length,
              admittedResults: loop.results.map(result => ({ taskId: result.taskId, attempt: result.attempt,
                status: result.status, ref: clone(result.ref) })) } };
          await save();
        }
        if (loop.attempt.restore) {
          const restoredFrom = await observeStatus(loop.attempt.restore.producer.runId ?? loop.attempt.restore.producer.key, true);
          assertFallbackProducer(restoredFrom, loop.attempt.restore.producer);

          // Persist before launch; replay observes this exact key, never replaces it.
          delete loop.attempt.restore.undispatched;
          await save();
        }
        const descriptor = clone(loop.attempt);
        let result = await collect(descriptor.key, "pitako.worker",
          { label: task.goal, phase: "implementation" }, `${fullContext()}
EXECUTE SINGLE TASK. No delegation, next-task selection, private diary/progress file or parallel TODO.
The workflow owns review and compliance; do not launch or infer another reviewer.
Preserve required checks and native permissions/Stop. Do not commit or publish unless task authority explicitly permits it.
COMPLETE SHARED CONTEXT:\n${JSON.stringify(activePlan.sharedContext)}
DIRECT PREREQUISITE COMPLETED RESULTS (historical references, not current check evidence):
${JSON.stringify(prerequisites)}
Read relevant full results and check current assumptions; do not automatically repeat all prerequisite gates.
COMPLETE SELECTED TASK:\n${JSON.stringify(task)}
FROZEN ATTEMPT:\n${JSON.stringify(descriptor)}
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
Retain returned partialRef/checkpointRef and restored.json in git.checkpoints.
Return restoreReceipt with the complete actual helper receipt position/candidate/checkpointRef/partialRef,
plus restoredRef (actual restored.json path) and digest (actual original manifest file SHA-256 from the helper receipt).
This is direct writer execution evidence, not an independent inspector attestation. A settled restore
receipt means do NOT restore again after later task edits. Then capture the NEW checkpoint below
before pending work. Complete only this task and run current required checks.
` : ""}PRE-WRITE CHECKPOINT INTENTION (not a backup until published):
${JSON.stringify(descriptor.checkpoint)}
Call the registered writer tool checkpoint_create({kind:"pre", paths:[exact authorized relative paths]})
before ANY checkout write (after the required restore above on fallback). Inspect structured ok/status
and actual artifact references; a failed or unavailable tool means no modifying work.
Native launch context binds this attempt to its durable intention/progress. Do not construct request
scripts, private state paths, manifests or receipts for capture/seal, or invent missing context.
Writer helper for attributed writes and restoration ONLY: ${config.checkpointHelper ?? "skills/execute/checkpoint.mjs"}.
Read its source/usage. Use apply for every affected-file write: it journals exact pre/postimages before atomic effects.
Do not bypass the effect journal with ordinary edit/write/patch commands.
The manifest limits rollback, not scope. If another affected path is needed, return useful
same-task continuation before writing it; the next attempt captures a new unit.
Capture failure means no modifying work. Existing artifacts require reconciliation, never overwrite.
Retain checkpoint refs in git.checkpoints. Never restore a unit with an admitted complete result.
After all owned writes settle, call checkpoint_create({kind:"unit"}) for a completed implementation unit.
Return its actual structured checkpointReceipt and retain checkpointRef in git.checkpoints; do not
reconstruct the receipt. Tool success/sealing is NOT task confirmation or cursor advancement.
Only root durable result admission confirms that point.
For a cooperative normal pause, when native control still permits capture, call checkpoint_create({kind:"pause"}) and
return the actual receipt with non-complete status (blocked, continue or gaps), remaining pending work, and yield control: its cursor stays pending. This captures current
WIP, not task completion. Stop/refusal or abrupt disappearance does NOT trigger seal or extra edits;
the previous confirmed point remains authoritative. Never fabricate a post-cut checkpoint.
Restoration is checkpoint-first after best-effort pertinent writer observation. Missing or
inconclusive historical receipts do not require resume/inspector chains. Positive current
activity and native Stop/refusal/permission/capacity remain barriers; never fabricate settlement.
Restore only journal-attributable effects, retaining partial bytes first; never reset/clean Git
or roll back consumed slots/history. Returned position is for existing root state reconciliation,
not permission to overwrite native mission state or promote stale checks.
ORIGINAL COMPLETE PLAN REFERENCES (fallback, never previews): ${JSON.stringify(loop.plan.ref)}
If inline definition is unavailable, read ORIGINAL COMPLETE loop_plan through these exact references,
validate full association, manifest ${JSON.stringify(loop.manifest)}, order/index and selected task ID BEFORE edits.
No definition => report blocked, never reconstruct scopes. Continuation reads the exact preceding result
${JSON.stringify(descriptor.continuationRef)} and addresses only useful diagnosed pending work on THIS task.
Report taskId/attempt/status, workDone, concrete remaining, causal diagnosis, usefulProgress/continuation,
Git HEAD/checkpoints/WIP and actual command/cwd/output/logPaths/result for EVERY planned check.
Identify each check by its admitted ID. Requirement wording comes from the plan; an optional
requirement echo is descriptive only. Never replace execution evidence with an ID or native ok.
Additional diagnostic checks use distinct IDs and retain actual results; they are not new mandatory gates.
Use null for uncaptured diagnostic before/after identities; retain declared identities without inventing hashes.
Do not conceal material defects in diagnostics: report them as pending work. Only planned checks determine mandatory currency.
Use existing extensions/spec-plans.ts checkoutEvidence(root) identity BEFORE/AFTER checks and AFTER LAST writes;
include head/fingerprint candidate. A check only passes for that unchanged final candidate (including WIP).
Use ordinary tools, inspect host resources and actual tasks before large checks. No blind retries.
Return structured_output; complete requires all planned checks current and no pending work.
continue requires useful progress plus concrete diagnosed continuation, not a replacement plan.`,
          workerSchema, true);
        loop.attempt.launch = nativeReference(descriptor.key, result);
        // Missing modifying results use the same checkpoint route on first
        // receipt as on replay; an inspector is not a rollback prerequisite.
        if (barrier(result) === "interrupted" || (pendingCheckpointUnit() && !barrier(result) &&
            !(result?.ok && result.structuredOutput && text(result.runId)))) {
          loop.attempt.stage = "launched";
          await save();
          result = await continueAttempt(result, loop.attempt.launch, task, prerequisites);
          if (result === null) continue;
        }
        if (barrier(result)) {
          loop.attempt.stage = "launched";
          throw nativeBarrier(barrier(result));
        }
        loop.attempt.stage = "launched";
        await save();
        if (!result?.ok) {
          loop.attempt.stage = "settled";
          loop.results.push({ ...projection(descriptor.key, result), taskId: descriptor.taskId, attempt: descriptor.number,
            checkpoint: { key: descriptor.checkpoint.key, manifest: `.pi/subagents/checkpoints/${descriptor.checkpoint.key}/manifest.json` } });
          await save();
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          break;
        }
        if (!result.structuredOutput) {
          const recovered = await inspectRecovery("attempt-result", loop.attempt.launch);
          if (recovered.status !== "recovered" || !recovered.workerResult)
            throw new Error(`Unresolved writer result: ${recovered.reason}`);
          value = admitWorker({ ...result, structuredOutput: recovered.workerResult }, descriptor, task,
            loop.recoveries.find(item => item.subject === `attempt-result:${descriptor.taskId}:${descriptor.number}`).ref);
        } else value = admitWorker(result, loop.attempt, task);
        await save();
        if (value.status === "blocked" || confirmedPausePending()) {
          return finish("blocked", loop.halt.reason);
        }
      }
      if (loop.cursor < loop.manifest.length) {
        loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
        loopReport("gaps", "Task has pending work without a useful diagnosed same-task continuation.");
        continue;
      }
      loop.candidate = loop.results[loop.results.length - 1].candidate;
      loop.phase = "review"; await save();
    }
    if (loop.phase === "review") {
      await reconcileAnalysis();
      progress();
      // reviewPhase owns its actual dynamic angles/critique/one-defense/synthesis.
      // Replay reconciles each retained call; repeating a key is not observation.
      const reviewRuns = { all: requests => analysisDispatch(requests.map(request => ({
        ...request, cwd: config.root, reads: false, progress: false,
      }))).then(results => {
        results.forEach((result, index) => usage(result, requests[index].key));
        return results;
      }) };
      const reviewed = await reviewPhase({
        brief: `${fullContext()}\nReview the COMPLETE authorized result against ALL specs, not director tasks alone.
Admitted COMPLETE plan references: ${JSON.stringify(loop.plan.ref)}.
Assess single-outcome decomposition and necessary dependencies independently; schema cannot certify semantics.
Do not repeat correct completed implementation merely to improve its past decomposition.
Candidate including WIP: ${JSON.stringify(loop.candidate)}.
Actual final checks/result references: ${JSON.stringify(loop.results)}.
No own writer is active. Do not run checks or repair. Only clear screening permits compliance.`,
        target: { kind: "solution", reference: JSON.stringify(loop.candidate),
          material: `Entire designated checkout ${config.root}, immutable full specs above and native work/check artifacts.
Read the actual sources and full referenced reports, not previews. Candidate: ${JSON.stringify(loop.candidate)}.` },
      }, reviewRuns, { prefix: `${key}.l${loop.number}.review.`, mode: "execute" });
      if (persistenceFailed) throw new Error(persistenceReason);
      // A second failed observation must not erase the original lookup refs.
      const reviewRefs = new Map((loop.review?.references ?? []).map(ref => [ref.key, ref]));
      reviewed.references.forEach(ref => reviewRefs.set(ref.key, {
        ...reviewRefs.get(ref.key), ...nativeReference(ref.key, ref), barrier: barrier(ref), reused: ref.reused === true,
      }));
      loop.review = { status: reviewed.status, phase: reviewed.phase,
        verdict: reviewed.screening?.verdict ?? "blocked", reason: excerpt(reviewed.screening?.reason ?? reviewed.error),
        nativeFailure: reviewed.nativeFailure ?? null,
        references: [...reviewRefs.values()] };
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
      loop.phase = reviewed.screening.verdict === "clear" ? "compliance" : "closing";
      await save();
    }
    if (loop.phase === "compliance") {
      await reconcileAnalysis();
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
Candidate INCLUDING WIP: ${JSON.stringify(loop.candidate)}.
Work and actual final mandatory checks: ${JSON.stringify(loop.results)}.
Reasoned shared adversarial clear: ${JSON.stringify(loop.review)}.
Admitted COMPLETE plan references: ${JSON.stringify(loop.plan.ref)}.
Independently assess single-outcome decomposition and dependency completeness against the full spec;
structural validation cannot prove them. Do not repeat correct work to improve past decomposition.
Read the actual full reports and sources via exact refs. Green/TODO/completed is not fulfillment.
Return fulfilled ONLY with reasoned complete requirements coverage, current mandatory checks,
no unresolved material gaps and this SAME candidate. Otherwise gaps or blocked. No post-review repair.`,
        complianceSchema, false, analysisDispatch);
      const value = result?.structuredOutput;
      const complianceRef = loop.compliance?.ref;
      loop.compliance = { ...projection(complianceKey, result), candidate: value?.candidate ? candidate(value.candidate) : null,
        reason: excerpt(value?.reason) };
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
      loop.phase = "closing"; await save();
    }
    if (loop.phase === "closing") {
      progress();
      if (loop.closing && replay && !same(loop.closing.candidate, currentCandidate)) {
        loop.invalidated = "candidate-changed-after-close";
        loop.closing.sameCandidate = false;
        loop.closing.resumeCandidate = currentCandidate;
      }
      // Exactly one native closing comparison per loop. No model validator.
      if (!loop.closing) {
        const closed = await host(config.inspections[loop.number]);
        loop.closing = { candidate: candidate(closed.checkout),
          sameCandidate: same(candidate(closed.checkout), loop.candidate),
          ref: references[references.length - 1] ?? { key: config.inspections[loop.number].key } };
        await save();
      }
      const fulfilled = loop.closing.sameCandidate && loop.review?.verdict === "clear" &&
        loop.compliance?.status === "fulfilled" && same(loop.compliance.candidate, loop.candidate) &&
        loop.results[loop.results.length - 1]?.checks?.current;
      loop.outcome = fulfilled ? "complete" : "gaps"; loop.endedAt = Date.now();
      loop.phase = "finished"; activePlan = null;
      try { await save(); } catch (error) {
        // A failed essential close is a suspension, not a durable loop outcome.
        delete loop.outcome; delete loop.endedAt; loop.phase = "closing";
        throw error;
      }
      if (fulfilled) return finish("complete", "Whole-spec fulfillment and mandatory checks verified for the current candidate. No more loops required.");
      loopReport("gaps", !loop.closing.sameCandidate ? "Candidate changed; affected checks and analyses are stale."
        : "Material adversarial or compliance gaps remain; next director receives exact evidence.");
    }
  }
} catch (error) {
  let reason = String(error?.message ?? error);
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
    try { await state.set(key, { ...(invocation ?? { version: 3 }), hostHalt }); }
    catch (saveError) {
      persistenceFailed = true;
      persistenceReason = `Essential persistence failed; host observation could not be retained: ${String(saveError?.message ?? saveError)}`;
    }
    return finish(hostHalt.status, `${hostHalt.reason} ${reason}`);
  }
  // Child timeout is partial, NOT invocation cancellation. Native Stop is reported
  // only from an observed barrier, not inferred from an exception's task wording.
  const stopped = ["stopped", "interrupted"].includes(error?.nativeBarrier);
  if (stopped) reason = "Execution cancelled.";
  const status = stopped ? "cancelled" : error?.nativeBarrier ? "blocked" :
    loop?.halt ? loop.halt.status : error?.nativeFailure || persistenceFailed ? "partial" : "blocked";
  if (loop?.halt?.reason && !reason.includes(loop.halt.reason))
    reason = `${loop.halt.reason} ${reason}`;
  if (loop && !persistenceFailed) {
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
