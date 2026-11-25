/** Pure part of director admission; also used on the retained settlement. */
export function planConflictReason(value, result, expectedRunId, equal) {
  const text = value => typeof value === "string" && value.trim().length > 0;
  if (!value || !(value.select === null || text(value.select)) || !Array.isArray(value.changes) || !text(value.reason))
    return "Invalid backlog selection.";
  if (result && ((result.agent && result.agent !== "pitako.execution-director") ||
      !text(result.runId) || (expectedRunId && result.runId !== expectedRunId)))
    return "backlog selection producer/run identity conflict.";
  if (text(result?.output) && /^\s*\{/.test(result.output)) {
    let binding;
    try { binding = JSON.parse(result.output); } catch { return "Invalid complete backlog selection binding JSON."; }
    if (!equal(binding, value)) return "Changed/conflicting backlog selection binding; no edits authorized.";
  }
  return null;
}

export function inspectorConflictReason(result, equal) {
  const value = result?.structuredOutput;
  if (!result?.ok || !value || !Array.isArray(value.provenance) || !value.provenance.length ||
      !value.provenance.every(item => typeof item === "string" && item.trim()) ||
      typeof value.reason !== "string" || !value.reason.trim() ||
      !["recovered", "lost", "conflict", "unresolved"].includes(value.status)) return null;
  if (typeof result.output === "string" && /^\s*\{/.test(result.output)) {
    let binding;
    try { binding = JSON.parse(result.output); } catch { return "Invalid complete recovery binding JSON."; }
    if (!equal(binding, value)) return "Changed/conflicting recovery binding.";
  }
  if (value.status === "conflict" || value.binding === "changed" || value.comparison === "different-full-json")
    return `Changed/conflicting recovery evidence: ${value.reason}`;
  return null;
}

export function viewOverflowReason(receipt) {
  return receipt?.error === "loop-io" && receipt.viewOverflow === true && typeof receipt.reason === "string"
    ? receipt.reason : null;
}

export function checkpointWitnessIssue(witness, expected) {
  if (["key", "taskId", "attempt", "loop", "cursor"].some(field => witness[field] !== expected[field]))
    return "Checkpoint observation conflicts with pending unit.";
  return typeof witness.error === "string" && witness.error.trim()
    ? `Checkpoint observation unavailable: ${witness.error}` : null;
}

export function checkpointMismatchReason(paths) {
  const details = paths.map(entry =>
    `${entry.path}: journaled sha256 ${entry.journaled ?? "absence"}, actual sha256 ${entry.actual ?? "absence"}, last step partially applied: ${entry.partiallyApplied}`).join("; ");
  const diagnostic = details.length > 300 ? `${details.slice(0, 300).toWellFormed()}…` : details;
  return `Checkpoint journal integrity conflict: ${diagnostic}.
Return the files to their journaled bytes before starting a new invocation.`;
}

/** Project native references without retaining output bodies. */
export function nativeReference(childKey, result, timeout = false) {
  const ref = { key: childKey };
  const text = value => typeof value === "string" && value.trim().length > 0;
  const review = childKey.includes(".review.");
  // A timeout must project the same witnesses from live delivery and the journal.
  const controls = review || timeout;
  if (review && !timeout && text(result?.error)) ref.error = result.structuredOutput === undefined ? result.error
    : result.error.split("\n\nOutput:\n")[0]
      .replaceAll(JSON.stringify(result.structuredOutput, null, 2), "[retained failed original]")
      .replaceAll(JSON.stringify(result.structuredOutput), "[retained failed original]");
  for (const field of ["agent", "runId", "asyncDir", "outputReference", "outputArtifactPath", "outputPathMapping", "artifactPaths", "externalAdapter",
    ...(controls ? ["model", "nativeKey", "workflowKey", "outputSaveError", "metadataSaveError", "exitCode", "timedOut", "terminalOutcome", "stopped", "interrupted", "detached", "recovery", "toolBudgetBlocked", "state"] : [])])
    if (result?.[field] !== undefined) ref[field] = result[field];
  // Only the recovery barrier is control evidence; full acceptance metadata and
  // per-result debug paths stay in the native run.
  const recovery = item => item?.acceptance?.recovery !== undefined ? { acceptance: { recovery: item.acceptance.recovery } } : {};
  if (controls) Object.assign(ref, recovery(result));
  if (!controls) {
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

/** Positive barriers in a concrete settlement, never a status preview. */
export function settledBarrier(result) {
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
  return null;
}
