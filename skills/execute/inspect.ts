import { checkoutEvidence, designatedWorkspace, discoverSpec, executionAmendments, inspectionSnapshot, preliminarySpec, specChunks, validatePlanId, validateSpec } from "../../extensions/spec-plans.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { boundRetainedAnalyses, retainedAnalyses } from "../../extensions/execute-retained.ts";
import { checkpointEvidence } from "../../extensions/execute-checkpoint.ts";
import { isDeepStrictEqual } from "node:util";
import { executionStatePath } from "../../extensions/execute-state.ts";

type Inspection = { root: string; id: string; source: string; part?: string; context?: string; agentDir?: string; lines: string[] };
function emitBounded(run: Inspection, value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded + "\n") > 4096) throw new Error("Inspection envelope exceeds the native 4096-byte stdout boundary.");
  run.lines.push(encoded);
}
// The exact mission is the same durable state read by the active root. Absence
// is admission; a partial/conflicting association is never a fresh invocation.
function admittedInvocation({ root, id, part }: Inspection, context: any) {
  let mission: any;
  try { mission = JSON.parse(readFileSync(executionStatePath(context), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const invocation = mission?.[`invoke-${context.invocation}`], legacy = mission?.["pitako-execution"];
  if (invocation === undefined && legacy === undefined) return false;
  if (!invocation || ![2, 3, 4].includes(invocation.version))
    throw new Error("Incompatible retained invocation; no settings admission.");
  if (invocation.association && !isDeepStrictEqual(invocation.amendments ?? [], context.amendments ?? []))
    throw new Error("Immutable admission amendments changed; preserve the retained path, SHA-256 and provenance. Do not merge or replace references on recovery.");
  const association = invocation.association;
  if (association && part === "admission" && (invocation.version !== 4 || !/^[a-f0-9]{64}$/.test(invocation.admissionBinding ?? "")))
    throw new Error("Retained execution predates bound native admission; no migration or replay is supported. Preserve its evidence; inspect actual native state. A terminal root cannot resume.");
  if (association === undefined) {
    const request = invocation.hostHalt?.request;
    if (legacy || invocation.version !== 4 || !request || invocation.hostHalt.code !== "host-observation" ||
        Object.keys(invocation).some(key => !["version", "hostHalt", "resolutions", "hostReconstruction", "activePlan"].includes(key)) ||
        (invocation.activePlan !== undefined && invocation.activePlan !== null) ||
        request.missionId !== context.missionId || request.missionPath !== context.missionPath ||
        request.invocation !== context.invocation || request.root !== root || request.id !== id ||
        typeof request.inspectionCommand !== "string" ||
        !isDeepStrictEqual(request.sourceRefs, context.sourceRefs))
      throw new Error("Incomplete retained invocation; no settings admission.");
    return false;
  }
  if (!association || association.missionId !== context.missionId || association.missionPath !== context.missionPath ||
      association.invocation !== context.invocation || association.root !== root ||
      typeof association.source !== "string" || typeof association.digest !== "string" ||
      (invocation.version === 4 && (!Number.isSafeInteger(association.maxCycles) || association.maxCycles < 1 ||
        !isDeepStrictEqual(association.sourceRefs, context.sourceRefs))) ||
      (invocation.version === 2 && (association.maxCycles !== undefined || context.sourceRefs.length)) ||
      (legacy && (legacy.version !== invocation.version || !isDeepStrictEqual(legacy.association, association))))
    throw new Error("Incompatible retained association; no settings admission.");
  return true;
}
// Planning validates only the root; execution uses the named resource's exact
// inspections. No writes. Returns the exact stdout of the inspect.mjs argument vector.
export async function inspect(argv: string[]): Promise<string> {
  const [root, id, source, part] = argv;
  if (!root || !id || source === undefined) throw new Error("Expected root, ID, and source selector.");
  const run: Inspection = { root, id, source, part, context: argv[4], agentDir: argv[5], lines: [] };
  if (part === "admission") {
    try {
      const observed = preliminarySpec(root, id, source || undefined);
      const context = JSON.parse(run.context ?? "null");
      const admitted = admittedInvocation(run, context);
      executionAmendments(observed.root, context.amendments, true);
      const { sourceRefs, agentDir } = context.admission;
      for (const ref of sourceRefs) {
        const content = readFileSync(ref.path, "utf8");
        validateSpec(content, path.basename(ref.path, ".md"));
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== ref.digest) throw new Error(`Complete spec source hash mismatch: ${ref.path}; expected ${ref.digest}, observed ${actual}`);
      }
      let admission;
      if (!admitted) {
        if (!agentDir || !path.isAbsolute(agentDir)) throw new Error("Expected absolute host agent directory for settings admission.");
        const { executeMaxCycles } = await import("../../extensions/execute-settings.ts");
        admission = { maxCycles: executeMaxCycles(observed.root, agentDir) };
      }
      const { head, fingerprint } = checkoutEvidence(observed.root);
      const recovery = admitted ? boundRetainedAnalyses(observed.root, observed.commonDir, observed.source,
        observed.digest, observed.binding, context) : undefined;
      const checkpointObservation = admitted ? observeCheckpoint({ root: observed.root, commonDir: observed.commonDir, selected: observed }, context) : undefined;
      emitBounded(run, { version: 1, binding: observed.binding, checkout: { head, fingerprint }, ...(admission ? { admission } : {}),
        ...(recovery ? { recoveryDigest: recovery.digest } : {}), ...(checkpointObservation ? { checkpointObservation } : {}) });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      const next = "Reconcile the identified input and explicitly prepare admission with the intended version. For an admitted invocation preserve its snapshot, restore reliable exact originals and deliver desired changes as a human addendum; unavailable originals remain blocked. Native barriers require supported native inspection/reconciliation, not source correction.";
      const failure = { version: 1, error: message, next };
      // Even unusually long paths/errors must produce a complete failure document.
      if (Buffer.byteLength(JSON.stringify(failure) + "\n") > 4096)
        failure.error = "Admission failed; detailed diagnostic exceeds envelope. Inspect the exact authorized host command inputs and selected source; observed identity unavailable.";
      emitBounded(run, failure);
    }
  } else if (part === "settings") {
    try {
      const { executeMaxCycles } = await import("../../extensions/execute-settings.ts");
      const agentDir = run.agentDir;
      if (!agentDir || !path.isAbsolute(agentDir)) throw new Error("Expected absolute host agent directory for settings admission.");
      const sourceRefs = JSON.parse(run.context ?? "[]") as { path: string; digest: string }[];
      for (const ref of sourceRefs) {
        const content = readFileSync(ref.path, "utf8");
        validateSpec(content, path.basename(ref.path, ".md"));
        if (createHash("sha256").update(content).digest("hex") !== ref.digest)
          throw new Error(`Complete spec source hash mismatch: ${ref.path}`);
      }
      emitBounded(run, { maxCycles: executeMaxCycles(root, agentDir) });
    } catch (error) {
      // Native failed-command summaries truncate at 200 characters. Transport the
      // complete admission diagnostic; this successful read is NOT admission.
      emitBounded(run, { error: String(error instanceof Error ? error.message : error) });
    }
  } else if (part === "root") {
    validatePlanId(id);
    run.lines.push(JSON.stringify(designatedWorkspace(root)));
  } else {
    await inspectSelected(run);
  }
  return run.lines.map(line => line + "\n").join("");
}
async function inspectSelected(run: Inspection) {
  const { root, id, source, part } = run;
  const found = discoverSpec(root, id, source || undefined);
  const candidates = found.selected ? [] : found.candidates.map(({ source, digest }) => ({ source, digest }));
  const context = run.context ? JSON.parse(run.context) : undefined;
  const admitted = context?.admissionTransport ? admittedInvocation(run, context) : true;
  let admission: { maxCycles: number } | undefined;
  if (context?.admission && !admitted) {
    try {
      const { sourceRefs, agentDir } = context.admission;
      if (!agentDir || !path.isAbsolute(agentDir)) throw new Error("Expected absolute host agent directory for settings admission.");
      for (const ref of sourceRefs) {
        const content = readFileSync(ref.path, "utf8");
        validateSpec(content, path.basename(ref.path, ".md"));
        if (createHash("sha256").update(content).digest("hex") !== ref.digest)
          throw new Error(`Complete spec source hash mismatch: ${ref.path}`);
      }
      const { executeMaxCycles } = await import("../../extensions/execute-settings.ts");
      admission = { maxCycles: executeMaxCycles(root, agentDir) };
    } catch (error) {
      emitBounded(run, { error: String(error instanceof Error ? error.message : error) });
      // No partial metadata or default limit accompanies an admission error.
      return;
    }
  }
  const retained = context && admitted && found.selected && (part !== "metadata" || context.admission || !context.admissionTransport)
    ? retainedAnalyses(found.root, found.selected.source, found.selected.digest, context) : undefined;
  const checkpointObservation = context && admitted && part === "metadata" ? observeCheckpoint(found, context) : undefined;
  const metadata = { root: found.root, commonDir: found.commonDir, candidates,
    selected: found.selected ? { source: found.selected.source, digest: found.selected.digest, chunks: specChunks(found.selected.content).length } : null,
    ...(retained?.length ? { retainedAnalyses: retained } : {}),
    ...(checkpointObservation ? { checkpointObservation } : {}) };
  if (part === undefined) run.lines.push(JSON.stringify({ ...metadata, checkout: checkoutEvidence(found.root) }));
  else if (!found.selected) {
    if (part !== "metadata") throw new Error("Invalid snapshot chunk request.");
    // Only ambiguity needs locations. Foreground inspection above retains the complete list.
    const ambiguity = { root: found.root as string | undefined, selected: null, candidates: [] as typeof candidates,
      candidateCount: candidates.length, candidatesOmitted: candidates.length };
    if (Buffer.byteLength(JSON.stringify(ambiguity) + "\n") > 4096) ambiguity.root = undefined;
    for (const candidate of candidates) {
      const next = { ...ambiguity, candidates: [...ambiguity.candidates, candidate], candidatesOmitted: ambiguity.candidatesOmitted - 1 };
      if (Buffer.byteLength(JSON.stringify(next) + "\n") > 4096) break;
      ambiguity.candidates = next.candidates; ambiguity.candidatesOmitted = next.candidatesOmitted;
    }
    emitBounded(run, { ...ambiguity, ...(admission ? { admission } : {}) });
  } else {
    const checkout = checkoutEvidence(found.root);
    const inline = { ...metadata, checkout };
    const content = specChunks(found.selected.content);
    // Reserve only the largest valid admission receipt, also on packet reads,
    // so initial and chunk operations make the same transport decision without
    // rereading settings. Error receipts above use their own complete envelope.
    const envelope = context?.admissionTransport ? { ...inline, admission: { maxCycles: Number.MAX_SAFE_INTEGER } } : inline;
    if (Buffer.byteLength(JSON.stringify(envelope) + "\n") <= 4096) {
      if (part === "metadata") emitBounded(run, { ...inline, ...(admission ? { admission } : {}) });
      else {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= content.length) throw new Error("Invalid snapshot chunk request.");
        emitBounded(run, { digest: found.selected.digest, content: content[Number(part)] });
      }
    } else {
      // Share the existing 26 snapshot grants: spec text stays unencoded, while metadata
      // uses only the remaining measured bytes of each complete JSON envelope.
      const { transport, packets } = inspectionSnapshot(metadata, found.selected.content);
      if (part === "metadata") emitBounded(run, { selected: { digest: found.selected.digest }, transport, checkout, ...(admission ? { admission } : {}) });
      else {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= packets.length) throw new Error("Invalid snapshot chunk request.");
        emitBounded(run, packets[Number(part)]);
      }
    }
  }
}

function observeCheckpoint(found: { root: string; commonDir: string; selected?: { source: string; digest: string } }, context: any) {
  let observation;
  if (context && found.selected) {
    let mission;
    try { mission = JSON.parse(readFileSync(executionStatePath(context), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const invocation = mission?.[`invoke-${context.invocation}`];
    const loop = invocation?.version === 4 ? invocation.loop : invocation?.loops?.at(-1), attempt = loop?.attempt;
    if (loop?.phase === "implementation" && (attempt?.checkpoint || attempt?.restore?.checkpoint || attempt?.restore?.sourceKeys) && (attempt.stage !== "result" || ["blocked", "continue", "gaps"].includes(attempt.result?.status))) {
      const association = invocation.association;
      if (association.root !== found.root || association.commonDir !== found.commonDir ||
          association.source !== found.selected.source || association.digest !== found.selected.digest ||
          association.missionId !== context.missionId || association.missionPath !== context.missionPath ||
          association.invocation !== context.invocation || !isDeepStrictEqual(association.sourceRefs, context.sourceRefs))
        throw new Error("Checkpoint observation association mismatch.");
      const retainedSources = invocation.version === 4 ? (attempt.restore?.sourceKeys ?? invocation.taskFrame?.restorationKeys ?? []).map((key: string) => {
        const intent = invocation.taskFrame?.sources?.find((item: any) => item.key === key);
        if (!intent) throw new Error("Missing authenticated restoration source intent.");
        return intent;
      }) : [].concat(attempt.restore?.checkpoint ?? attempt.pauseSource?.sources ?? attempt.pauseSource?.checkpoint ?? []);
      const sources = [attempt.checkpoint, ...retainedSources.filter((item: any) => item.key !== attempt.checkpoint?.key)].filter(Boolean);
      const subject = { key: attempt.key, taskId: attempt.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor };
      try {
        if (sources.some(source => !isDeepStrictEqual(source.association, association) || source.taskId !== subject.taskId ||
            source.loop !== subject.loop || source.cursor !== subject.cursor || source.attempt > subject.attempt))
          throw new Error("Checkpoint observation pending-task mismatch.");
        const confirmed = invocation.version === 4 ? invocation.lastConfirmed : loop.confirmedCheckpoint;
        const unit = attempt.restore?.authority?.confirmedUnit ?? (confirmed?.kind === "unit" && confirmed.position.loop === loop.number ? confirmed : undefined);
        if (unit) {
          const { taskId, attempt: number, resultRef, ...receipt } = unit;
          const result = loop.results.map((item: any) => {
            if (item.ref) return item;
            const completed = invocation.tasks?.[item.taskId]?.completed;
            return completed?.attempt === item.attempt ? completed : undefined;
          }).find((item: any) => item?.taskId === taskId && item.attempt === number && isDeepStrictEqual(item.ref, resultRef));
          if (!result || result.status !== "complete" || !isDeepStrictEqual(result.checkpoint?.confirmation, receipt) ||
              !isDeepStrictEqual(unit.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
              unit.checkpointRef !== `${found.root}/.pi/subagents/checkpoints/${result.checkpoint.key}/unit.json`)
            throw new Error("Confirmed unit conflicts with admitted pending progress.");
        }
        observation = { ...subject, evidence: checkpointEvidence(sources, invocation.version === 4
          ? { consumedLoops: invocation.consumedLoops, admitted: Object.fromEntries(
            Object.entries(invocation.tasks).filter(([, task]: [string, any]) => task.admitted.length)
              .map(([id, task]: [string, any]) => [id, task.admitted])) }
          : { consumedLoops: invocation.loops.length, admittedResults: loop.results }, unit) };
      } catch (error) { observation = { ...subject, error: String(error instanceof Error ? error.message : error) }; }
    }
  }
  return observation;
}
