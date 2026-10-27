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
  before: candidateSchema, after: candidateSchema,
});
const workerSchema = object({
  taskId: string, attempt: integer, status: { enum: ["complete", "continue", "gaps", "blocked"] },
  workDone: string, remaining: list(string), diagnosis: string,
  usefulProgress: { type: "boolean" }, continuation: nullable(string),
  git: object({ head: string, checkpoints: list(string), wip: string }),
  candidate: candidateSchema, checks: list(checkSchema),
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
  original: nullable(planSchema), workerResult: nullable(workerSchema),
  originalAvailable: { type: "boolean" },
  binding: { enum: ["identical", "absent", "changed", "unavailable"] },
  comparison: { enum: ["equal-full-json", "different-full-json", "only-original", "neither"] },
  provenance: list(string),
});
const key = `invoke-${config.invocation}`;
const references = [];
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
function nativeBarrier(cause) {
  const error = new Error(`Positive native barrier: ${cause}`);
  error.nativeBarrier = cause;
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
  return Promise.resolve().then(() => runs.all(requests)).then(results => {
    results.forEach((result, index) => {
      if (!result?.ok) {
        const cause = nativeFailure(requests[index].key, result?.error ?? "Native child failed.", result);
        if (cause.code === "capacity") result.nativeFailure = cause;
      }
    });
    return results;
  }).catch(error => {
    if (/^Blocked by pi-subagents permission rule:/.test(String(error?.message ?? error)))
      throw nativeBarrier("native permission denial");
    const cause = nativeFailure(requests[0].key, error);
    const failure = new Error(cause.reason);
    failure.nativeFailure = cause;
    throw failure;
  });
}
function observeStatus(ref) {
  return runs.status(ref).catch(error => {
    const message = String(error?.message ?? error);
    const prefix = `Status '${ref}' failed: `;
    const cause = message.startsWith(prefix)
      ? barrier({ results: [], output: message.slice(prefix.length) }, ref) : null;
    if (cause) throw nativeBarrier(cause);
    if (/Blocked by pi-subagents permission rule:/.test(message)) throw nativeBarrier("native permission denial");
    // Missing inventory is not positive activity; exceptional recovery still
    // has to reconcile the original result before another writer is allowed.
  });
}
function host(grant) {
  if (!grant) return Promise.reject(new Error("Missing trusted inspection grant."));
  return runs.host(grant.key, { kind: "command", command: grant.command, timeoutMs: 86400000 }).then(result => {
    if (text(result.outputPath)) references.push({ key: grant.key, outputReference: result.outputPath });
    if (!result.ok) throw new Error([result.error || "Read-only inspection failed.", result.stderr].filter(Boolean).join("\n"));
    return JSON.parse(result.stdout);
  });
}
function capture(current) {
  const header = current.transport;
  const count = header?.chunks ?? current.selected.chunks;
  if (!Number.isInteger(count) || count < 1 || count > 26) throw new Error("Invalid snapshot chunk count.");
  if (header && (!/^[a-f0-9]{64}$/.test(header.digest ?? "") ||
      !Number.isInteger(header.bytes) || header.bytes < 1 || header.bytes > 39936 ||
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
let invocation, loop, activePlan, currentCandidate, replay = false;
let persistenceFailed = false;
let persistenceReason = null;
function maxCycles() { return invocation?.version === 3 ? invocation.association.maxCycles : 3; }
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
    loopsConsumed: invocation?.loops.length ?? 0, maxLoops: maxCycles(),
    label: `Loop ${loop?.number ?? 0} de ${maxCycles()}`, phase: loop?.phase ?? "admission",
    ...(loop?.attempt ? { taskId: loop.attempt.taskId, attempt: loop.attempt.number } : {}),
    elapsedMs: invocation ? Date.now() - invocation.startedAt : null, tokens: metrics(),
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
function collect(childKey, agent, task, outputSchema, implementation = false) {
  progress();
  return dispatch([{
    key: childKey, agent, context: "fresh", cwd: config.root,
    output: `${childKey}.json`, outputMode: "file-only", reads: false, progress: false,
    skill: ["verify-behavior"], task, outputSchema,
    ...(implementation ? { timeoutMs: 14400000, acceptance: {
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
  return value;
}
function fullContext() {
  return `ASSOCIATION (data): ${JSON.stringify(association(loop.number))}
COMPLETE IMMUTABLE SPEC SNAPSHOT:\n${invocation.snapshot.content}
ADDITIONAL COMPLETE SPEC SOURCES (immutable path + SHA-256): ${JSON.stringify(invocation.association.sourceRefs ?? [])}
BEFORE reasoning, planning, editing, checking, reviewing or compliance: read EVERY referenced source IN FULL
and verify its SHA-256 with existing read/hash tools. Missing/mismatched/incomplete sources => blocked,
never silently omit inherited obligations or treat summaries as full specs. Selected snapshot remains intact.
Prior loop/result references (data): ${JSON.stringify(invocation.loops.filter(item => item !== loop).map(item => ({
    loop: item.number, outcome: item.outcome, plan: item.plan?.ref, attempts: item.results,
    review: item.review, compliance: item.compliance, closing: item.closing,
  })))}`;
}
function inspectRecovery(kind, ref) {
  const recoveryKey = `${key}.l${loop.number}.recover${loop.recoveries.length + 1}`;
  return collect(recoveryKey, "pitako.execution-inspector", `EXCEPTIONAL READ-ONLY ${kind} recovery. No tests, writes or delegation.
${fullContext()}
Use existing read tools and ONLY these exact native producer/run/output references, plus Git/WIP:
${JSON.stringify(ref)}
Frozen descriptor and manifest (data): ${JSON.stringify({ attempt: loop.attempt, manifest: loop.manifest })}
Expected association: ${JSON.stringify(association(loop.number))}
Recover the ORIGINAL COMPLETE native structured value, not output previews, summaries, reconstructed scopes or IDs.
Distinguish JSON binding/outputArtifactPath/outputPathMapping from optional results[].structuredOutputPath
and debug artifactPaths. Compare COMPLETE JSON values when binding and original both survive.
Changed/conflicting binding is conflict; absent binding plus original is recovered in place, no artifact copying.
An optional witness missing is not loss of an admitted full payload. If no trustworthy complete definition survives, return lost.
For attempt-result recovery return the exact original full workerResult only when actually retained and settled;
otherwise unresolved. Report exact provenance and availability. Do not infer settlement from missing inventory.
Use structured_output.`, recoverySchema).then(result => {
    loop.recoveries.push(projection(recoveryKey, result));
    const value = result?.structuredOutput;
    if (barrier(result)) throw nativeBarrier(barrier(result));
    if (!result?.ok || !value || !Array.isArray(value.provenance) ||
        !value.provenance.length || !text(value.reason)) throw new Error("Recovery has no authoritative complete observation.");
    return value;
  });
}
function recoverPlan() {
  const ref = loop.plan.ref;
  return observeStatus(ref.runId ?? ref.key).then(result => {
    if (barrier(result, ref.runId ?? ref.key)) throw nativeBarrier(barrier(result, ref.runId ?? ref.key));
    // Status that actually contains the original full value is usable, unlike management previews.
    const original = result?.structuredOutput;
    if (original && text(result.runId) && (!ref.runId || result.runId === ref.runId)) {
      validatePlan(original, loop.number, loop.manifest);
      if (activePlan && !same(activePlan, original)) throw new Error("Conflicting complete loop_plan values.");
      activePlan = original;
      loop.plan.ref = nativeReference(ref.key, result);
      // No model recovery when both actual complete values are directly present.
      if (text(result.output) && /^[\s]*\{/.test(result.output)) {
        let binding;
        try { binding = JSON.parse(result.output); } catch (_) { throw new Error("Invalid complete loop_plan binding JSON."); }
        if (!same(binding, original)) throw new Error("Changed/conflicting loop_plan binding; no edits authorized.");
        loop.plan.recoverySource = { ref: loop.plan.ref, binding: "identical", comparison: "equal-full-json" };
        return true;
      }
    }
  }).then(direct => direct === true ? null : inspectRecovery("loop-plan", ref)).then(observed => {
    if (observed === null) return true;
    if (observed.status === "conflict" || observed.binding === "changed" ||
        observed.comparison === "different-full-json") throw new Error("Changed/conflicting loop_plan binding; no edits authorized.");
    if (observed.originalAvailable && observed.original) {
      validatePlan(observed.original, loop.number, loop.manifest);
      if (activePlan && !same(activePlan, observed.original)) throw new Error("Conflicting complete loop_plan values.");
      activePlan = observed.original;
      loop.plan.recoverySource = { ref: loop.recoveries[loop.recoveries.length - 1].ref,
        binding: observed.binding, comparison: observed.comparison };
    }
    // Admitted cache is itself a complete value; optional witnesses are not mandatory.
    if (!activePlan) return false;
    validatePlan(activePlan, loop.number, loop.manifest);
    return true;
  });
}
function workerValue(result, descriptor, task) {
  const value = result?.structuredOutput;
  if (!result?.ok || !value || value.taskId !== descriptor.taskId || value.attempt !== descriptor.number ||
      !["complete", "continue", "gaps", "blocked"].includes(value.status) ||
      !text(value.workDone) || !text(value.diagnosis) || !Array.isArray(value.remaining) ||
      !value.remaining.every(text) || typeof value.usefulProgress !== "boolean" ||
      !(value.continuation === null || text(value.continuation)) ||
      !text(value.git?.head) || !text(value.git?.wip) || !Array.isArray(value.git.checkpoints))
    throw new Error("Worker returned no complete task/attempt/progress/diagnosis/Git contract.");
  candidate(value.candidate);
  if (value.git.head !== value.candidate.head || !Array.isArray(value.checks) ||
      value.checks.length !== task.checks.length ||
      new Set(value.checks.map(check => check.id)).size !== task.checks.length)
    throw new Error("Worker result lacks planned check evidence.");
  const checksCurrent = value.checks.every(check => {
    const definition = task.checks.find(entry => entry.id === check.id);
    if (!definition || !["command", "cwd", "requirement"].every(field => check[field] === definition[field]) ||
        !text(check.output) || !Array.isArray(check.logPaths) ||
        !["passed", "failed", "not-run"].includes(check.result))
      throw new Error("Check command/cwd/output/result differs from loop_plan.");
    return check.result === "passed" && same(candidate(check.before), candidate(check.after)) &&
      same(candidate(check.after), candidate(value.candidate));
  });
  if (value.status === "complete" && (!checksCurrent || value.remaining.length))
    throw new Error("Task complete contradicts current mandatory checks or pending work.");
  return { value, checksCurrent };
}
function admitWorker(result, descriptor, task) {
  const parsed = workerValue(result, descriptor, task);
  const value = parsed.value;
  const projected = { ...projection(descriptor.key, result), taskId: descriptor.taskId,
    attempt: descriptor.number, candidate: candidate(value.candidate),
    workDone: excerpt(value.workDone), diagnosis: excerpt(value.diagnosis),
    remaining: value.remaining.slice(0, 4).map(excerpt), remainingCount: value.remaining.length,
    checks: { current: parsed.checksCurrent, count: value.checks.length,
      passed: value.checks.filter(check => check.result === "passed").length,
      failed: value.checks.filter(check => check.result === "failed").length,
      notRun: value.checks.filter(check => check.result === "not-run").length },
    usefulContinuation: value.status === "continue" && value.usefulProgress &&
      value.remaining.length > 0 && text(value.continuation) && text(value.diagnosis),
    continuationIdentity: continuationIdentity(value),
  };
  if (loop.results.some(previous => previous.taskId === descriptor.taskId &&
      previous.continuationIdentity === projected.continuationIdentity))
    projected.usefulContinuation = false;
  loop.results.push(projected);
  loop.attempt.result = projected;
  loop.attempt.stage = "result";
  if (projected.status === "blocked") retainWorkerBlock(projected);
  currentCandidate = projected.candidate;
  return parsed.value;
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
      diagnosis: last?.diagnosis ?? null, references: [
      last?.ref, loop.review?.references, loop.compliance?.ref, loop.halt?.ref,
    ].filter(Boolean) }],
    next: loop.halt ? (persistenceFailed ? "restore essential persistence; resolve observed impediment before any continuation" : "resolve observed impediment") : persistenceFailed ? "restore essential persistence and resume this invocation" : status === "complete" ? "close" : status === "gaps" && invocation.loops.length < maxCycles()
      ? `continue loop ${loop.number + 1}` : status === "gaps" ? "new invocation requires human authorization" : "resolve observed impediment",
    actionRequired: !persistenceFailed && !loop.halt && (status === "complete" || (status === "gaps" && invocation.loops.length < maxCycles())) ? "none" : reason,
  };
  if (typeof emit === "function") emit(report);
  return report;
}
function finish(status, reason) {
  if (persistenceFailed && persistenceReason && !reason.includes(persistenceReason)) reason += ` ${persistenceReason}`;
  return {
    status, heading: `Execution ${status}`, reason, invocation: config.invocation,
    missionId: config.missionId, missionPath: config.missionPath,
    loopsConsumed: invocation?.loops.length ?? 0, maxLoops: maxCycles(),
    elapsedMs: Number.isFinite(invocation?.startedAt) ? Date.now() - invocation.startedAt : null, tokens: metrics(),
    phase: loop?.phase ?? "admission", candidate: loop?.closing?.candidate ?? currentCandidate ?? null,
    loopReport: loop ? loopReport(status === "partial" && loop.outcome === "gaps" && !persistenceFailed ? "gaps" : status, reason) : null,
    actionRequired: status === "complete" ? "none" : reason,
    publication: "not performed by workflow", references,
  };
}
try {
  if (config.unblock) return finish("blocked", "Obsolete --unblock is unsupported; historical records remain unchanged.");
  if (!text(config.missionId) || !text(config.missionPath) || !text(config.invocation))
    return finish("blocked", "Existing native missionId and actually returned missionPath are required.");
  invocation = await state.get(key);
  const legacy = await state.get("pitako-execution");
  if ((invocation && ![2, 3].includes(invocation.version)) || (legacy && ![2, 3].includes(legacy.version)))
    return finish("blocked", "Obsolete execute supervisor state cannot be replayed or migrated; retained unchanged.");
  if (legacy && (legacy.version !== invocation?.version || !same(legacy.association, invocation?.association) ||
      legacy.association.invocation !== config.invocation))
    return finish("blocked", "Native mission already belongs to another immutable invocation; no replacement writer dispatched.");
  const current = await host(config.inspections[0]);
  if (!current.selected) return finish("blocked", "Select complete unambiguous specs with the packaged inspector.");
  let metadata = current;
  if (!invocation) {
    const admitted = await host(config.settings);
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
      throw new Error("Immutable mission/invocation/snapshot/worktree association changed; retained unchanged.");
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
  currentCandidate = candidate(current.checkout);
  loop = invocation.loops[invocation.loops.length - 1];
  // Recover the old result-committed/outcome-not-committed cut before plan recovery.
  if (loop?.attempt?.stage === "result" && loop.attempt.result?.status === "blocked")
    retainWorkerBlock(loop.attempt.result);
  if (["capacity", "native-dispatch", "semantic-block"].includes(loop?.halt?.code))
    return finish(loop.halt.status, loop.halt.reason);
  // A prior barrier is not a historical universal hold. Recovery re-observes the
  // exact writer, or replays read-only phases under actual native permissions.
  // A completed verdict is reusable only for the same closing candidate.
  if (loop?.outcome === "complete" && same(loop.closing?.candidate, currentCandidate))
    return finish("complete", "Whole-spec fulfillment, mandatory checks and review remain bound to this candidate. No more loops required.");
  if (loop?.outcome === "complete") {
    loop.outcome = "gaps";
    loop.invalidated = "candidate-changed";
    await save();
  }
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
    if (loop.phase === "director") {
      const directorKey = `${key}.l${loop.number}.director`;
      if (!loop.plan) {
        loop.plan = { stage: "intention", ref: { key: directorKey } };
        await save();
        const result = await collect(directorKey, "pitako.execution-director", `${fullContext()}
READ-ONLY PLANNING ONLY. Do not delegate, implement, run checks/review, select workers,
maintain private TODOs or supervise execution. Return one COMPLETE loop_plan using structured_output
and the native output binding, then END. Status is plan or needs-decision, never implementation complete.
Root owns ordered selection and attempts. Tasks have stable logical IDs, complete scopes, effects,
sources/context, expected result and concrete mandatory checks. Include a LAST verification task
for final checks after all writes even when the implementation already exists. Shared context is complete.
No replacement task list elsewhere. Carry the exact association above. Native permissions and Stop apply.`,
          planSchema);
        loop.plan = { ...projection(directorKey, result), stage: "published" };
        if (barrier(result)) throw nativeBarrier(barrier(result));
        // Publication and admission are separate durable cuts.
        await save();
        activePlan = result?.structuredOutput;
        if (!result?.ok || !activePlan) throw new Error("Director did not publish a complete loop_plan.");
        validatePlan(activePlan, loop.number);
        // Some boundaries return complete binding content as output; never parse
        // file-only previews or use them as an alternate task definition.
        if (text(result.output) && /^[\s]*\{/.test(result.output)) {
          let binding;
          try { binding = JSON.parse(result.output); } catch (_) { throw new Error("Invalid complete loop_plan binding JSON."); }
          if (!same(binding, activePlan)) throw new Error("Changed/conflicting loop_plan binding.");
        }
      } else if (!activePlan) {
        if (!await recoverPlan()) {
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          loopReport("gaps", "Original complete loop_plan lost; no task reconstructed from IDs.");
          continue;
        }
      } else validatePlan(activePlan, loop.number, loop.manifest);
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
        attemptObservation = await observeStatus(ref.runId ?? ref.key);
        if (barrier(attemptObservation, ref.runId ?? ref.key))
          throw nativeBarrier(barrier(attemptObservation, ref.runId ?? ref.key));
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
        let value;
        if (loop.attempt?.stage === "result") {
          // Result is committed before cursor movement: do not repeat completed edits.
          const previous = loop.attempt.result;
          if (previous.status === "blocked") return finish("blocked", loop.halt.reason);
          if (previous.status === "complete") {
            loop.cursor++; loop.attempt = null; await save(); continue;
          }
          if (!previous.usefulContinuation) break;
          loop.attempt = { taskId: task.id, index: loop.cursor, number: previous.attempt + 1,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a${previous.attempt + 1}`,
            stage: "intention", continuationRef: previous.ref };
          await save();
        } else if (loop.attempt) {
          // Never call an unresolved writer key as if native reuse were read-only.
          const ref = loop.attempt.launch ?? { key: loop.attempt.key };
          const observed = attemptObservation ?? await observeStatus(ref.runId ?? ref.key);
          attemptObservation = null;
          if (barrier(observed, ref.runId ?? ref.key)) throw nativeBarrier(barrier(observed, ref.runId ?? ref.key));
          if (observed?.runId && observed?.structuredOutput && (!ref.runId || observed.runId === ref.runId)) {
            admitWorker(observed, loop.attempt, task);
          } else {
            const recovered = await inspectRecovery("attempt-result", ref);
            if (recovered.status !== "recovered" || !recovered.workerResult)
              throw new Error("Unresolved writer dispatch: inspect exact native run and Git/WIP; no blind reattachment or replacement.");
            admitWorker({ ok: true, runId: ref.runId, structuredOutput: recovered.workerResult }, loop.attempt, task);
          }
          await save(); continue;
        } else {
          loop.attempt = { taskId: task.id, index: loop.cursor, number: 1,
            key: `${key}.l${loop.number}.t${loop.cursor + 1}.a1`, stage: "intention", continuationRef: null };
          await save();
        }
        const descriptor = clone(loop.attempt);
        const result = await collect(descriptor.key, "pitako.worker", `${fullContext()}
EXECUTE SINGLE TASK. No delegation, next-task selection, private diary/progress file or parallel TODO.
The workflow owns review and compliance; do not launch or infer another reviewer.
Preserve required checks and native permissions/Stop. Do not commit or publish unless task authority explicitly permits it.
COMPLETE SHARED CONTEXT:\n${JSON.stringify(activePlan.sharedContext)}
COMPLETE SELECTED TASK:\n${JSON.stringify(task)}
FROZEN ATTEMPT:\n${JSON.stringify(descriptor)}
ORIGINAL COMPLETE PLAN REFERENCES (fallback, never previews): ${JSON.stringify(loop.plan.ref)}
If inline definition is unavailable, read ORIGINAL COMPLETE loop_plan through these exact references,
validate full association, manifest ${JSON.stringify(loop.manifest)}, order/index and selected task ID BEFORE edits.
No definition => report blocked, never reconstruct scopes. Continuation reads the exact preceding result
${JSON.stringify(descriptor.continuationRef)} and addresses only useful diagnosed pending work on THIS task.
Report taskId/attempt/status, workDone, concrete remaining, causal diagnosis, usefulProgress/continuation,
Git HEAD/checkpoints/WIP and actual command/cwd/output/logPaths/result for EVERY planned check.
Use existing extensions/spec-plans.ts checkoutEvidence(root) identity BEFORE/AFTER checks and AFTER LAST writes;
include head/fingerprint candidate. A check only passes for that unchanged final candidate (including WIP).
Use ordinary tools, inspect host resources and actual tasks before large checks. No blind retries.
Return structured_output; complete requires all planned checks current and no pending work.
continue requires useful progress plus concrete diagnosed continuation, not a replacement plan.`,
          workerSchema, true);
        loop.attempt.launch = nativeReference(descriptor.key, result);
        if (barrier(result)) {
          loop.attempt.stage = "launched";
          throw nativeBarrier(barrier(result));
        }
        if (!result?.ok) {
          loop.attempt.stage = "settled";
          loop.results.push({ ...projection(descriptor.key, result), taskId: descriptor.taskId, attempt: descriptor.number });
          await save();
          loop.outcome = "gaps"; loop.endedAt = Date.now(); await save();
          break;
        }
        value = admitWorker(result, descriptor, task);
        await save();
        if (value.status === "blocked") {
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
      progress();
      // reviewPhase owns its actual dynamic angles/critique/one-defense/synthesis.
      // Its keyed analysis calls may reuse; no writer is dispatched in this phase.
      const reviewRuns = { all: requests => dispatch(requests.map(request => ({
        ...request, cwd: config.root, reads: false, progress: false,
      }))).then(results => {
        results.forEach((result, index) => usage(result, requests[index].key));
        return results;
      }) };
      const reviewed = await reviewPhase({
        brief: `${fullContext()}\nReview the COMPLETE authorized result against ALL specs, not director tasks alone.
Candidate including WIP: ${JSON.stringify(loop.candidate)}.
Actual final checks/result references: ${JSON.stringify(loop.results)}.
No own writer is active. Do not run checks or repair. Only clear screening permits compliance.`,
        target: { kind: "solution", reference: JSON.stringify(loop.candidate),
          material: `Entire designated checkout ${config.root}, immutable full specs above and native work/check artifacts.
Read the actual sources and full referenced reports, not previews. Candidate: ${JSON.stringify(loop.candidate)}.` },
      }, reviewRuns, { prefix: `${key}.l${loop.number}.review.`, mode: "execute" });
      loop.review = { status: reviewed.status, phase: reviewed.phase,
        verdict: reviewed.screening?.verdict ?? "blocked", reason: excerpt(reviewed.screening?.reason ?? reviewed.error),
        nativeFailure: reviewed.nativeFailure ?? null,
        references: reviewed.references.map(ref => ({
          ...nativeReference(ref.key, ref), barrier: barrier(ref), reused: ref.reused === true,
        })) };
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
      const complianceKey = `${key}.l${loop.number}.compliance`;
      const result = await collect(complianceKey, "pitako.reviewer", `${fullContext()}
INDIVIDUAL READ-ONLY WHOLE-SPEC COMPLIANCE ANALYSIS. You are ONE fresh analyst, not a council,
director checklist, implementation worker or final presentation agent. No delegation, writes or tests.
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
Read the actual full reports and sources via exact refs. Green/TODO/completed is not fulfillment.
Return fulfilled ONLY with reasoned complete requirements coverage, current mandatory checks,
no unresolved material gaps and this SAME candidate. Otherwise gaps or blocked. No post-review repair.`,
        complianceSchema);
      const value = result?.structuredOutput;
      loop.compliance = { ...projection(complianceKey, result), candidate: value?.candidate ? candidate(value.candidate) : null,
        reason: excerpt(value?.reason) };
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
  // Child timeout is partial, NOT invocation cancellation. Native Stop is reported
  // only from an observed barrier, not inferred from an exception's task wording.
  const stopped = ["stopped", "interrupted"].includes(error?.nativeBarrier);
  if (stopped) reason = "Execution cancelled.";
  const status = stopped ? "cancelled" : error?.nativeBarrier ? "blocked" :
    loop?.halt ? loop.halt.status : error?.nativeFailure || persistenceFailed ? "partial" : "blocked";
  if (loop?.halt?.reason && !reason.includes(loop.halt.reason))
    reason = `${loop.halt.reason} ${reason}`;
  if (loop && !persistenceFailed) {
    loop.halt = loop.halt ?? { status, ...(error?.nativeFailure ?? {
      code: error?.nativeBarrier ? "native-barrier" : "recovery", reason: excerpt(reason),
      ...(error?.nativeBarrier ? { cause: error.nativeBarrier } : {}),
    }) };
    try { await save(); } catch (saveError) {
      reason += `${error?.nativeBarrier ? ` Observed native barrier: ${error.nativeBarrier}.` : ""} ${String(saveError?.message ?? saveError)}`;
    }
  }
  return finish(status, reason);
}
