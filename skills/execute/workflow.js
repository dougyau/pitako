// Expanded only by the named resource. config contains exact read-only host grants.
if (typeof state === "undefined") throw new Error("Explicit native mission binding is required before execution.");
const text = value => typeof value === "string" && value.trim().length > 0;
const string = { type: "string", minLength: 1 };
const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const resultSchema = object({ status: { enum: ["complete", "gaps", "blocked"] }, summary: string,
  remaining: string, evidence: string });
const nativeRefsSchema = { type: "array", maxItems: 32, items: string };
const preparationSchema = object({ status: { enum: ["ready", "blocked"] }, todo: string, evidence: string, nativeRefs: nativeRefsSchema });
const validationSchema = object({ status: { enum: ["verified", "blocked"] }, evidence: string });
const observationSchema = object({ evidence: string, nativeRefs: nativeRefsSchema });
const key = `invoke-${config.invocation}`;
const references = [];
const utf8Bytes = value => encodeURIComponent(value).replace(/%[0-9A-F]{2}|[^%]/g, "x").length;
function host(grant) {
  // Native API mandates a finite per-command timeout. No Pitako workflow/agent budget.
  return runs.host(grant.key, { kind: "command", command: grant.command, timeoutMs: 86400000 }).then(result => {
    if (!result.ok) throw new Error(result.error || "Read-only inspection failed.");
    if (text(result.outputPath)) references.push({ key: grant.key, outputReference: result.outputPath });
    return JSON.parse(result.stdout);
  });
}
function capture(current) {
  if (!current.transport) return Promise.resolve({ metadata: current });
  const header = current.transport;
  if (!/^[a-f0-9]{64}$/.test(header.digest ?? "") || !Number.isInteger(header.chunks) || header.chunks < 1 || header.chunks > 26 ||
      !Number.isInteger(header.bytes) || header.bytes < 1 || header.bytes > 26 * 1536 ||
      !Number.isInteger(header.contentBytes) || header.contentBytes < 1 || header.contentBytes > 26 * 1536)
    throw new Error("Invalid inspection metadata header.");
  let reconstruction = Promise.resolve({ encoded: "", content: "" });
  for (let index = 0; index < header.chunks; index++) {
    reconstruction = reconstruction.then(snapshot => host(config.chunks[index]).then(chunk => {
      if (chunk.index !== index || chunk.chunks !== header.chunks || chunk.metadataDigest !== header.digest || chunk.digest !== current.selected.digest ||
          typeof chunk.metadata !== "string" || typeof chunk.content !== "string" || utf8Bytes(chunk.content) > 1539 ||
          utf8Bytes(JSON.stringify(chunk) + "\n") > 4096)
        throw new Error("Inspection metadata changed or returned an invalid chunk.");
      return { encoded: snapshot.encoded + chunk.metadata, content: snapshot.content + chunk.content };
    }));
  }
  return reconstruction.then(({ encoded, content }) => {
    if (utf8Bytes(encoded) !== header.bytes || utf8Bytes(content) !== header.contentBytes)
      throw new Error("Incomplete inspection metadata reconstruction.");
    const metadata = JSON.parse(encoded);
    if (JSON.stringify(metadata) !== encoded || metadata.selected?.digest !== current.selected.digest)
      throw new Error("Invalid inspection metadata reconstruction.");
    return { metadata: { ...metadata, checkout: current.checkout }, content };
  });
}
function nativeReference(childKey, result) {
  const reference = { key: childKey };
  for (const field of ["runId", "artifactPaths", "outputReference", "asyncDir"])
    if (result?.[field] !== undefined) reference[field] = result[field];
  return reference;
}
function nativeTimeout(result) {
  // Native cause is not descendant settlement; model verdicts and wait receipts are not proof.
  return text(result?.runId) && result.state !== "running" && !result.stopped && !result.interrupted &&
    !result.detached && !result.recovery &&
    ((result.terminalOutcome?.state === "partial" && result.terminalOutcome.reason === "timeout") ||
      (result.results?.length === 1 && result.results[0]?.timedOut === true));
}
function nativeBarrier(result) {
  if (!result) return null;
  for (const field of ["stopped", "interrupted", "detached", "recovery"])
    if (result[field]) return field;
  if (result.state === "running") return "running";
  if (result.results?.some(child => child.stopped || child.interrupted || child.detached ||
      child.acceptance?.recovery || child.toolBudgetBlocked)) return "native child Stop/recovery/permission barrier";
  if (String(result.error ?? "").includes("Blocked by pi-subagents permission rule:")) return "native permission denial";
  return result.activity || null;
}
function managementWarning(reference, result) {
  // 0.82 public status loses some structured activity. Read ONLY positive management
  // warnings for this exact target, never prose/absence as a CLOSED certificate.
  if (!Array.isArray(result?.results) || result.results.length !== 0 || typeof result.output !== "string") return null;
  const lines = result.output.split("\n");
  if (lines[0] !== `Run: ${reference}` && lines[0] !== `Nested run: ${reference}`) return null;
  return lines.some(line => /^State: (running|queued|paused|stopped|rejected|live foreground)$/.test(line) ||
    /^\s*↳ .* \[[^\]]+\] (running|queued|paused|stopped|rejected)(?: \||$)/.test(line) ||
    /^\s*↳ \+[0-9]+ nested runs? \(.*[1-9][0-9]* (running|queued|paused|stopped|rejected)/.test(line) ||
    /^Pending appends: [1-9][0-9]*$/.test(line)) ? "native management activity warning" : null;
}
function observeRefs(refs) {
  return [...new Set(refs.filter(text))].reduce((pending, ref) => pending.then(observations =>
    runs.status(ref).then(result => [...observations, {
      ref, activity: nativeBarrier(result) || managementWarning(ref, result),
      note: "Status is an observation, not inactivity proof.",
    }], error => {
      const message = String(error?.message ?? error);
      return [...observations, { ref, activity: message.includes("Blocked by pi-subagents permission rule:") ? "native permission denial"
        : null,
        note: message }];
    })), Promise.resolve([]));
}
function compactResult(childKey, result) {
  if (!result) return null;
  const compact = { ...nativeReference(childKey, result), ok: result.ok };
  for (const field of ["error", "reused", "state", "stopped", "interrupted", "detached", "recovery"])
    if (result[field] !== undefined) compact[field] = result[field];
  compact.activity = nativeBarrier(result);
  // Provenance of our awaited call, not status.ok, a model assertion or universal closure.
  compact.nativeAwaited = !result.reused && !compact.activity;
  if (nativeTimeout(result)) compact.terminalOutcome = { state: "partial", reason: "timeout" };
  if (result.structuredOutput) {
    compact.structuredOutput = {};
    for (const field of ["status", "summary", "remaining", "evidence", "nativeRefs"])
      if (result.structuredOutput[field] !== undefined) compact.structuredOutput[field] = result.structuredOutput[field];
  }
  return compact;
}
function collect(childKey, agent, task, outputSchema) {
  return runs.all([{ key: childKey, agent, context: "fresh", cwd: config.root, output: false, task, outputSchema }]).then(([result]) => {
    if (result) references.push(nativeReference(childKey, result));
    return result;
  });
}
let invocation;
try {
  const observedInput = await host(config.inspections[0]);
  if (!observedInput.selected) return { status: "blocked", reason: "Select complete existing specs; ambiguity requires an explicit source choice. If locations were omitted, run the packaged inspector in the foreground without a part argument for the complete eligible location list.",
    candidates: observedInput.candidates, candidateCount: observedInput.candidateCount, candidatesOmitted: observedInput.candidatesOmitted, references };
  const captured = await capture(observedInput);
  const current = captured.metadata;
  let execution = await state.get("pitako-execution");
  if (execution && (execution.root !== current.root || execution.commonDir !== current.commonDir || execution.id !== config.id || execution.source !== current.selected.source))
    return { status: "blocked", reason: "Mission/spec/worktree association is ambiguous. Reconcile explicitly; no writer launched." };
  if (execution?.missionId && execution.missionId !== config.missionId)
    return { status: "blocked", reason: "Wrong native mission association; no exclusion withdrawn or writer launched." };
  if (execution?.digest && execution.digest !== current.selected.digest) return { status: "blocked", reason: "Source input changed since this execution; obtain an explicit human adoption and newly bound snapshot before proceeding." };
  invocation = await state.get(key);
  if (invocation && invocation.digest !== current.selected.digest)
    return { status: "blocked", reason: "Source input changed; retained invocation snapshot was not adopted or overwritten.", source: invocation.source, digest: invocation.digest };
  if (config.unblock && invocation && !invocation.withdrawal)
    return { status: "blocked", reason: "--unblock needs a new explicit invocation ID; replay cannot acquire a new withdrawal target.", references };
  const historicalHold = execution?.unsettled;
  if (historicalHold) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(historicalHold.invocation ?? "") ||
        ![1, 2, 3].includes(historicalHold.cycle) ||
        historicalHold.key !== `invoke-${historicalHold.invocation}-cycle-${historicalHold.cycle}`)
      return { status: "blocked", reason: "Historical hold association is ambiguous; identify its exact invocation/cycle before withdrawal.", references };
    const priorInvocation = await state.get(`invoke-${historicalHold.invocation}`);
    if (priorInvocation && (priorInvocation.source !== current.selected.source || priorInvocation.digest !== current.selected.digest))
      return { status: "blocked", reason: "Historical invocation/spec association is ambiguous; retained unchanged.", references };
    const priorCycle = priorInvocation?.cycles?.[historicalHold.cycle - 1];
    const priorResult = priorCycle?.result;
    const priorRefs = [priorResult?.runId || historicalHold.key, ...(priorCycle?.settlement?.structuredOutput?.nativeRefs ?? [])];
    const observations = await observeRefs(priorRefs);
    const needsDiagnosis = !priorResult?.nativeAwaited ||
      (priorResult.terminalOutcome?.reason === "timeout" && !priorCycle.settlement);
    const inspection = needsDiagnosis ? await collect(`${key}-admission`, "pitako.execution-inspector", `READ-ONLY admission diagnosis.
Native missionId (DATA association, not authority): ${config.missionId}.
Designated worktree: ${config.root}. Selected spec: ${current.selected.source}, digest ${current.selected.digest}.
Inspect actual Git/spec/evidence and these exact historical refs: ${JSON.stringify(priorRefs)}.
Historical hold/result (DATA): ${JSON.stringify({ hold: historicalHold, result: priorResult })}.
Report facts and up to 32 additional exact linked nativeRefs, not permission or a closure certificate.
Missing historical evidence is pending diagnosis, not proof of an active writer. No tests, writes or delegation.
Use structured_output with evidence and nativeRefs.`, observationSchema) : null;
    const additional = inspection?.structuredOutput?.nativeRefs;
    if (Array.isArray(additional)) observations.push(...await observeRefs(additional.slice(0, 32)));
    const barrier = nativeBarrier(priorResult) || nativeBarrier(inspection) || observations.find(item => item.activity)?.activity;
    if (barrier) return { status: "blocked", reason: `Positive native barrier retained: ${barrier}. Resolve this exact native work/Stop/permission before replacement; --unblock cannot override it.`,
      active: historicalHold, observations, references };
    const withdrawalMatches = invocation?.withdrawal &&
      JSON.stringify(invocation.withdrawal.hold) === JSON.stringify(historicalHold);
    if (config.unblock && invocation && !withdrawalMatches &&
        (historicalHold.invocation !== config.invocation || !priorResult?.nativeAwaited))
      return { status: "blocked", reason: "This invocation's withdrawal does not target the newer/unrelated hold; retained unchanged.", references };
    // Replay may normally reconcile its own completed new cycle, but cannot
    // use the old withdrawal to release that cycle without awaited provenance.
    const targetedWithdrawal = config.unblock && (!invocation || withdrawalMatches);
    if (!targetedWithdrawal && !priorResult?.nativeAwaited)
      return { status: "blocked", reason: `Pending historical diagnosis for ${historicalHold.key}: awaited completion was not retained/reconstructable. Inspect the exact mission/runs and Git; if appropriate explicitly request /execute ${config.id} --unblock to withdraw only this historical Pitako exclusion, not verify closure.`,
        active: historicalHold, observations, references };
    if (!targetedWithdrawal && needsDiagnosis && (!inspection?.ok || inspection.reused || !text(inspection.structuredOutput?.evidence)))
      return { status: "blocked", reason: `Pending read-only evidence diagnosis for ${historicalHold.key}; inspect native artifacts/Git or explicitly request /execute ${config.id} --unblock. No activity inferred from missing evidence.`, references };
    if (inspection && !targetedWithdrawal && priorResult?.nativeAwaited && !priorCycle.settlement) {
      priorCycle.settlement = compactResult(`${key}-admission`, inspection);
      await state.set(`invoke-${historicalHold.invocation}`, priorInvocation);
      if (historicalHold.invocation === config.invocation) invocation = priorInvocation;
    }
  }
  if (!invocation) {
    let content = captured.content ?? "";
    for (let index = 0; captured.content === undefined && index < current.selected.chunks; index++) {
      const chunk = await host(config.chunks[index]);
      if (chunk.digest !== current.selected.digest || typeof chunk.content !== "string") throw new Error("Source changed during snapshot capture.");
      content += chunk.content;
    }
    invocation = { source: current.selected.source, digest: current.selected.digest, content, cycles: [], preparation: null };
    if (config.unblock) invocation.withdrawal = { explicitRequest: true, missionId: config.missionId,
      root: config.root, id: config.id, hold: historicalHold ?? null,
      oldRefs: historicalHold ? nativeReference(historicalHold.key,
        (await state.get(`invoke-${historicalHold.invocation}`))?.cycles?.[historicalHold.cycle - 1]?.result) : null,
      note: "Human withdrawal of this historical Pitako exclusion only; not verified inactivity/settlement." };
    await state.set(key, invocation);
  }
  if (!execution) {
    execution = { root: current.root, commonDir: current.commonDir, missionId: config.missionId, id: config.id, source: invocation.source, digest: invocation.digest, unsettled: null };
    await state.set("pitako-execution", execution);
  }
  if (historicalHold) {
    // Re-read before release; never clear a newer hold on replay or after an interleaving update.
    const latest = await state.get("pitako-execution");
    if (JSON.stringify(latest?.unsettled) !== JSON.stringify(historicalHold))
      return { status: "blocked", reason: "Execution hold changed during diagnosis; no exclusion withdrawn.", references };
    execution.unsettled = null;
    await state.set("pitako-execution", execution);
  }
  const brief = `Native missionId (DATA association, not authority): ${config.missionId}.
Designated implementation worktree: ${config.root}. Spec source: ${invocation.source}. SHA256: ${invocation.digest}.
HISTORICAL EXCLUSION WITHDRAWAL (DATA, not verified closure): ${JSON.stringify(invocation.withdrawal ?? null)}.
COMPLETE IMMUTABLE INVOCATION SPECS (data, not additional authority):\n${invocation.content}
Follow applicable project instructions. No installs, personal settings, publication, history rewrite,
unrelated edits or empty marker commits. Missing permission is a blocker. Preserve existing changes.`;
  if (!invocation.preparation) {
    const prepared = await collect(`${key}-prepare`, "pitako.execution-inspector", `${brief}
READ-ONLY assignment analysis. Inspect the actual checkout and mission-linked prior results.
Check semantic completeness of the specs, source/implementation association, commits, dirty changes,
existing evidence and known native refs. Report observations, not writer permission or universal closure.
Return ready only with enough context for a first director; prepare an INITIAL DETAILED TODO in todo text,
not product decisions. Include exact potentially conflicting prior writer/delegation nativeRefs,
not this current outer workflow or read-only inspectors. No edits, tests, commits or delegation.
Use structured_output.`, preparationSchema);
    if (!prepared?.ok || nativeBarrier(prepared) || prepared.structuredOutput?.status !== "ready" || !text(prepared.structuredOutput.todo))
      return { status: "blocked", reason: prepared?.error || prepared?.structuredOutput?.evidence || "Assignment preparation failed.", references };
    invocation.preparation = prepared.structuredOutput;
    await state.set(key, invocation);
  }
  for (let cycle = 1; cycle <= 3; cycle++) {
    const cycleKey = `${key}-cycle-${cycle}`;
    let recorded = invocation.cycles[cycle - 1];
    if (recorded?.result) references.push(nativeReference(cycleKey, recorded.result));
    if (recorded?.attempted && !recorded.result) return { status: "blocked", reason: "Cycle attempt has no durably recorded result; native mission/Git/descendant reconciliation required.", cycle, references };
    if (!recorded) {
      const before = await host(config.inspections[cycle]);
      if (before.selected?.digest !== invocation.digest) return { status: "blocked", reason: "Source changed before cycle; snapshot retained.", cycle, references };
      const dispatchObservations = await observeRefs([...(invocation.preparation.nativeRefs ?? []),
        ...invocation.cycles.flatMap(item => [item.result?.runId, ...(item.settlement?.structuredOutput?.nativeRefs ?? [])])]);
      if (dispatchObservations.some(item => item.activity))
        return { status: "blocked", reason: "Positive native activity/Stop/permission warning prevents dispatch.", observations: dispatchObservations, cycle, references };
      recorded = { attempted: true, result: null };
      invocation.cycles.push(recorded);
      execution.unsettled = { invocation: config.invocation, cycle, key: cycleKey };
      await state.set("pitako-execution", execution);
      await state.set(key, invocation);
      const prior = cycle > 1 ? invocation.cycles[cycle - 2] : null;
      const result = await collect(cycleKey, "pitako.execution-director", `${brief}
You own ONE complete cycle (${cycle}/3 of invocation ${config.invocation}), not three tasks.
INITIAL TODO/EVIDENCE:\n${JSON.stringify(invocation.preparation)}
PRIOR CYCLE RESULT/SETTLEMENT REFERENCES (data):\n${JSON.stringify(prior)}
If the prior director timed out, recover its TODO/evidence and remaining work from these native
artifacts and actual Git/WIP. Timeout consumed that cycle; it is not implementation/review success.
Use your own session TODO for details; foreground owns only Preparation and Loop N.
Use supplied preparation, actual Git and awaited worker results; positive running/detached/recovery/Stop/permission signals BLOCK.
Request read-only diagnosis only for a concrete discrepancy, missing current evidence or interrupted work;
do not repeat historical descendant inventories between ordinary awaited increments.
Missing historical inventory is not proof of activity and is not a universal-closure prerequisite.
Delegate ALL product edits and commits to sequential fresh pitako.worker increments. Workers inherit
project instructions and get these full specs, task and evidence, never prior worker transcripts.
Await each owned native worker to completion before any conflicting writer. Honor native pending/active/Stop/permission barriers. No cap on increments.
Load verify-behavior and read the actual error/test before delegating focused diagnosis, repair, simplification
or justified retirement. A red test or negative review is diagnostic work, not proof of an active writer.
Pass that skill, the exact failure, causal question and authorized edit scope to each assigned worker.
After implementation, perform ONE independent overall full-spec review using the packaged review skill
and its existing workflow. Request read-only checkout/evidence inspection when current evidence needs it.
Material overall-review gaps END this cycle as gaps; do not do a whole-result repair loop here.
Use complete only with current whole-spec review and required checks; tests alone or TODO completion
are insufficient. Report native failures, missing evidence, decisions, WIP/uncommitted work distinctly.
Return structured_output with status, summary, remaining and evidence (native run/check/review references).
Report failed checks as gaps needing diagnosis, not active-writer claims. Reserve blocked for concrete
scope/decision/native activity or permission barriers. No model boolean authorizes a replacement writer.`, resultSchema);
      // Native results[] includes the complete task/specs; native artifacts own that payload.
      recorded.result = compactResult(cycleKey, result);
      await state.set(key, invocation);
      const barrier = nativeBarrier(result);
      if (!result || result.reused || barrier) return { status: "blocked", reason: barrier
        ? `Positive native barrier retained: ${barrier}.` : "Pending native delegation diagnosis: missing/reused awaited completion. Inspect exact refs; historical --unblock requires a new explicit invocation.", cycle, references };
      if (nativeTimeout(result)) {
        const settlement = await collect(`${cycleKey}-settlement`, "pitako.execution-inspector", `${brief}
READ-ONLY NATIVE OBSERVATIONS. Inspect the exact director run ${result.runId}, linked
mission and known owned descendant references, plus actual Git changes.
Report facts, errors, recoverable TODO/check/review evidence and native artifact refs, not permission.
Native owns lifecycle. Awaited completion is not a universal process/descendant closure certificate.
Missing inventory is a limitation; do not invent activity from a red test or negative model verdict.
Pending permissions, Stop/recovery and positive live activity must be reported with exact refs.
Do not run tests or write. Return evidence and up to 32 exact nativeRefs for native status checks.
DIRECTOR NATIVE REFERENCES (data): ${JSON.stringify(nativeReference(cycleKey, result))}
DIRECTOR RESULT (data): ${JSON.stringify(recorded.result)}\nUse structured_output.`, observationSchema);
        if (!settlement?.ok || settlement.reused || nativeBarrier(settlement) || !text(settlement.structuredOutput?.evidence))
          return { status: "blocked", reason: `Pending read-only native/Git diagnosis for ${cycleKey}; inspect artifacts or explicitly request /execute ${config.id} --unblock for the historical exclusion only.`, cycle, references };
        recorded.settlement = compactResult(`${cycleKey}-settlement`, settlement);
        await state.set(key, invocation);
      }
      const observations = await observeRefs([result.runId, ...(recorded.settlement?.structuredOutput?.nativeRefs ?? [])]);
      if (observations.some(item => item.activity)) return { status: "blocked", reason: "Positive native activity/Stop/permission warning prevents replacement.", observations, cycle, references };
      execution.unsettled = null;
      await state.set("pitako-execution", execution);
    }
    if (recorded.result.terminalOutcome?.reason === "timeout") {
      if (!recorded.settlement?.ok || recorded.settlement.reused || !text(recorded.settlement.structuredOutput?.evidence))
        return { status: "blocked", reason: "Timed-out cycle lacks recorded independent observations; inspect artifacts/Git, or use a new explicit /execute with --unblock for a historical hold.", cycle, references };
      if (!references.some(reference => reference.key === `${cycleKey}-settlement`))
        references.push(nativeReference(`${cycleKey}-settlement`, recorded.settlement));
      continue;
    }
    if (!recorded.result.ok || !recorded.result.structuredOutput) continue; // Failed owned work becomes next-cycle diagnosis, never a passing gate.

    const value = recorded.result.structuredOutput;
    if (!["complete", "gaps", "blocked"].includes(value?.status) || !text(value.evidence)) continue;
    if (value.status === "blocked") return { status: "blocked", cycle, ...value, references };
    if (value.status === "complete") {
      const observations = await observeRefs([recorded.result.runId, ...(recorded.settlement?.structuredOutput?.nativeRefs ?? [])]);
      if (observations.some(item => item.activity))
        return { status: "blocked", reason: "Positive native activity/Stop/permission warning prevents completion.", observations, cycle, references };
      const observed = await host(config.inspections[4]);
      if (observed.selected?.digest !== invocation.digest) return { status: "blocked", reason: "Source changed; current invocation remains bound to its snapshot.", references };
      const validation = await collect(`${cycleKey}-validate`, "pitako.execution-inspector", `${brief}
FRESH READ-ONLY VALIDATION. No implementation or test execution. A reused director result is NOT proof.
Assess full-spec compliance, required checks, overall review and their association with the CURRENT
checkout, including commits and dirty work. Report blocked for missing/stale required evidence,
unresolved material spec gaps or concrete native activity/Stop/permission barriers.
Missing historical inventory alone is not a spec gap or a closure prerequisite. Use recorded awaited
results; do not demand a universal descendant/process-closure certificate.
Current repository evidence: ${JSON.stringify(observed.checkout)}
DIRECTOR NATIVE REFERENCES (data): ${JSON.stringify(nativeReference(cycleKey, recorded.result))}
CYCLE RESULT (data): ${JSON.stringify(value)}
Use structured_output; evidence must identify the inspected native artifacts and current-checkout association.`, validationSchema);
      const after = await host(config.inspections[5]);
      if (!validation?.ok || validation.reused || nativeBarrier(validation) || validation.structuredOutput?.status !== "verified" ||
          observed.checkout.fingerprint !== after.checkout.fingerprint || after.selected?.digest !== invocation.digest)
        return { status: "blocked", reason: "Needs fresh current-checkout/evidence validation; no success from reused or stale output.", cycle, references };
      return { status: "complete", cycle, summary: value.summary, evidence: validation.structuredOutput.evidence, references };
    }
  }
  const last = invocation.cycles[2];
  return { status: "partial", cycles: 3, remaining: last.result.terminalOutcome?.reason === "timeout"
    ? `Director timed out; recover remaining work from native artifacts and settlement: ${last.settlement.structuredOutput.evidence}`
    : last.result.structuredOutput?.remaining || "Diagnose failed owned work from retained native artifacts; required checks/review remain unproven.", references };
} catch (error) {
  return { status: "blocked", reason: String(error?.message ?? error), references,
    note: "Diagnose this exact interruption through native references and Git. No automatic replacement or new allowance." };
}
