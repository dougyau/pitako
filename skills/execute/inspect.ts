import { checkoutEvidence, designatedWorkspace, discoverSpec, inspectionSnapshot, specChunks, validatePlanId, validateSpec } from "../../extensions/spec-plans.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { retainedAnalyses } from "../../extensions/execute-retained.ts";
import { checkpointEvidence } from "../../extensions/execute-checkpoint.ts";
import { isDeepStrictEqual } from "node:util";

// Planning validates only the root; execution uses the named resource's exact inspections. No writes.
const [root, id, source, part] = process.argv.slice(2);
if (!root || !id || source === undefined) throw new Error("Expected root, ID, and source selector.");
function emitBounded(value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded + "\n") > 4096) throw new Error("Inspection envelope exceeds the native 4096-byte stdout boundary.");
  console.log(encoded);
}
// The exact mission is the same durable state read by the active root. Absence
// is admission; a partial/conflicting association is never a fresh invocation.
function admittedInvocation(context: any) {
  let mission: any;
  try { mission = JSON.parse(readFileSync(context.missionPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const invocation = mission?.[`invoke-${context.invocation}`], legacy = mission?.["pitako-execution"];
  if (invocation === undefined && legacy === undefined) return false;
  if (!invocation || ![2, 3].includes(invocation.version))
    throw new Error("Incompatible retained invocation; no settings admission.");
  const association = invocation.association;
  if (association === undefined) {
    const request = invocation.hostHalt?.request;
    if (legacy || invocation.version !== 3 || !request || invocation.hostHalt.code !== "host-observation" ||
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
      (invocation.version === 3 && (!Number.isSafeInteger(association.maxCycles) || association.maxCycles < 1 ||
        !isDeepStrictEqual(association.sourceRefs, context.sourceRefs))) ||
      (invocation.version === 2 && (association.maxCycles !== undefined || context.sourceRefs.length)) ||
      (legacy && (legacy.version !== invocation.version || !isDeepStrictEqual(legacy.association, association))))
    throw new Error("Incompatible retained association; no settings admission.");
  return true;
}
if (part === "settings") {
  try {
    const { executeMaxCycles } = await import("../../extensions/execute-settings.ts");
    const agentDir = process.argv[7];
    if (!agentDir || !path.isAbsolute(agentDir)) throw new Error("Expected absolute host agent directory for settings admission.");
    const sourceRefs = JSON.parse(process.argv[6] ?? "[]") as { path: string; digest: string }[];
    for (const ref of sourceRefs) {
      const content = readFileSync(ref.path, "utf8");
      validateSpec(content, path.basename(ref.path, ".md"));
      if (createHash("sha256").update(content).digest("hex") !== ref.digest)
        throw new Error(`Complete spec source hash mismatch: ${ref.path}`);
    }
    emitBounded({ maxCycles: executeMaxCycles(root, agentDir) });
  } catch (error) {
    // Native failed-command summaries truncate at 200 characters. Transport the
    // complete admission diagnostic; this successful read is NOT admission.
    emitBounded({ error: String(error instanceof Error ? error.message : error) });
  }
} else if (part === "root") {
  validatePlanId(id);
  console.log(JSON.stringify(designatedWorkspace(root)));
} else {
  await inspectSelected();
}
async function inspectSelected() {
  const found = discoverSpec(root, id, source || undefined);
  const candidates = found.selected ? [] : found.candidates.map(({ source, digest }) => ({ source, digest }));
  const context = process.argv[6] ? JSON.parse(process.argv[6]) : undefined;
  const admitted = context?.admissionTransport ? admittedInvocation(context) : true;
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
      emitBounded({ error: String(error instanceof Error ? error.message : error) });
      // No partial metadata or default limit accompanies an admission error.
      return;
    }
  }
  const retained = context && admitted && found.selected && (part !== "metadata" || context.admission || !context.admissionTransport)
    ? retainedAnalyses(found.root, found.selected.source, found.selected.digest, context) : undefined;
  let checkpointObservation;
  if (context && admitted && found.selected && part === "metadata") {
    let mission;
    try { mission = JSON.parse(readFileSync(context.missionPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const invocation = mission?.[`invoke-${context.invocation}`];
    const loop = invocation?.loops?.at(-1), attempt = loop?.attempt;
    if (loop?.phase === "implementation" && (attempt?.checkpoint || attempt?.restore?.checkpoint) && (attempt.stage !== "result" || ["blocked", "continue", "gaps"].includes(attempt.result?.status))) {
      const association = invocation.association;
      if (association.root !== found.root || association.commonDir !== found.commonDir ||
          association.source !== found.selected.source || association.digest !== found.selected.digest ||
          association.missionId !== context.missionId || association.missionPath !== context.missionPath ||
          association.invocation !== context.invocation || !isDeepStrictEqual(association.sourceRefs, context.sourceRefs))
        throw new Error("Checkpoint observation association mismatch.");
      const sources = [attempt.checkpoint, ...[].concat(attempt.restore?.checkpoint ?? [])].filter(Boolean);
      const subject = { key: attempt.key, taskId: attempt.taskId, attempt: attempt.number, loop: loop.number, cursor: loop.cursor };
      try {
        if (sources.some(source => !isDeepStrictEqual(source.association, association) || source.taskId !== subject.taskId ||
            source.loop !== subject.loop || source.cursor !== subject.cursor || source.attempt > subject.attempt))
          throw new Error("Checkpoint observation pending-task mismatch.");
        const unit = attempt.restore?.authority?.confirmedUnit ?? (loop.confirmedCheckpoint?.kind === "unit" ? loop.confirmedCheckpoint : undefined);
        if (unit) {
          const { taskId, attempt: number, resultRef, ...receipt } = unit;
          const result = loop.results.find((item: any) => item.taskId === taskId && item.attempt === number && isDeepStrictEqual(item.ref, resultRef));
          if (!result || result.status !== "complete" || !isDeepStrictEqual(result.checkpoint?.confirmation, receipt) ||
              !isDeepStrictEqual(unit.position, { loop: loop.number, cursor: loop.cursor, phase: "implementation" }) ||
              unit.checkpointRef !== `${found.root}/.pi/subagents/checkpoints/${result.checkpoint.key}/unit.json`)
            throw new Error("Confirmed unit conflicts with admitted pending progress.");
        }
        checkpointObservation = { ...subject, evidence: checkpointEvidence(sources, { consumedLoops: invocation.loops.length, admittedResults: loop.results }, unit) };
      } catch (error) { checkpointObservation = { ...subject, error: String(error instanceof Error ? error.message : error) }; }
    }
  }
  const metadata = { root: found.root, commonDir: found.commonDir, candidates,
    selected: found.selected ? { source: found.selected.source, digest: found.selected.digest, chunks: specChunks(found.selected.content).length } : null,
    ...(retained?.length ? { retainedAnalyses: retained } : {}),
    ...(checkpointObservation ? { checkpointObservation } : {}) };
  if (part === undefined) console.log(JSON.stringify({ ...metadata, checkout: checkoutEvidence(found.root) }));
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
    emitBounded({ ...ambiguity, ...(admission ? { admission } : {}) });
  } else {
    const checkout = checkoutEvidence(found.root);
    const inline = { ...metadata, checkout };
    const content = specChunks(found.selected.content);
    // Reserve only the largest valid admission receipt, also on packet reads,
    // so initial and chunk operations make the same transport decision without
    // rereading settings. Error receipts above use their own complete envelope.
    const envelope = context?.admissionTransport ? { ...inline, admission: { maxCycles: Number.MAX_SAFE_INTEGER } } : inline;
    if (Buffer.byteLength(JSON.stringify(envelope) + "\n") <= 4096) {
      if (part === "metadata") emitBounded({ ...inline, ...(admission ? { admission } : {}) });
      else {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= content.length) throw new Error("Invalid snapshot chunk request.");
        emitBounded({ digest: found.selected.digest, content: content[Number(part)] });
      }
    } else {
      // Share the existing 26 snapshot grants: spec text stays unencoded, while metadata
      // uses only the remaining measured bytes of each complete JSON envelope.
      const { transport, packets } = inspectionSnapshot(metadata, found.selected.content);
      if (part === "metadata") emitBounded({ selected: { digest: found.selected.digest }, transport, checkout, ...(admission ? { admission } : {}) });
      else {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= packets.length) throw new Error("Invalid snapshot chunk request.");
        emitBounded(packets[Number(part)]);
      }
    }
  }
}
