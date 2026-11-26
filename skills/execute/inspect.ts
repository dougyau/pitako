import { checkoutEvidence, designatedWorkspace, discoverSpec, executionAmendments, inspectionSnapshot, preliminarySpec, specChunks, validatePlanId, validateSpec } from "../../extensions/spec-plans.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { boundRetainedAnalyses, earlyAnalysisReplayGap, retainedAnalyses, retainedExecuteHalt } from "../../extensions/execute-retained.ts";
import { checkpointEvidence } from "../../extensions/execute-checkpoint.ts";
import { isDeepStrictEqual } from "node:util";
import { executionStatePath } from "../../extensions/execute-state.ts";
import { EXECUTE_CURSOR_KEY, validateExecuteCursor, type ExecuteCursor } from "../../extensions/execute-cursor.ts";
import { readExecuteIntentContext, type ExecuteIntentBody } from "../../extensions/execute-intent.ts";
import { boundEpochAdvanceReplay, boundExecuteTimeoutProjection, readExecuteAdmission, readExecuteSelectionReplay, readInitialAdvanceReplay } from "../../extensions/execute-progress.ts";
import { StoreError } from "../../extensions/pitako-store.ts";

type Inspection = { root: string; id: string; source: string; part?: string; context?: string; agentDir?: string; lines: string[] };
function emitBounded(run: Inspection, value: unknown) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded + "\n") > 4096) throw new Error("Inspection envelope exceeds the native 4096-byte stdout boundary.");
  run.lines.push(encoded);
}
// The exact mission is the same durable state read by the active root. Absence
// is admission; a partial/conflicting association is never a fresh invocation.
function admittedInvocation({ root, id, part }: Inspection, context: any): ExecuteCursor | false {
  let mission: any;
  try { mission = JSON.parse(readFileSync(executionStatePath(context), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = mission?.[EXECUTE_CURSOR_KEY];
  // Only a cursor identified as belonging to another invocation may be replaced.
  if (value === undefined || typeof value?.invocation === "string" &&
      value.invocation && value.invocation !== context.invocation) return false;
  validateExecuteCursor(EXECUTE_CURSOR_KEY, value);
  let retained;
  try {
    retained = readExecuteAdmission(root, value);
  } catch (error) {
    // A failed store read must not hide a native key collision from the demand replay.
    if (part === "admission" && error instanceof StoreError &&
        !["superseded", "wrong-cwd"].includes(error.code) &&
        value.action.kind === "launched" && value.action.key.endsWith(".demand-observation")) {
      const gap = earlyAnalysisReplayGap(value, context.missionPath, context.missionId);
      if (gap) throw new Error(gap);
    }
    throw error;
  }
  const { cursor, admission } = retained;
  if (!isDeepStrictEqual(admission.amendments ?? [], context.amendments ?? []))
    throw new Error("Immutable admission amendments changed; preserve the retained path, SHA-256 and provenance. Do not merge or replace references on recovery.");
  const association = admission.association;
  if (part === "admission" && !/^[a-f0-9]{64}$/.test(cursor.admissionBinding))
    throw new Error("Retained execution predates bound native admission; no migration or replay is supported. Preserve its evidence; inspect actual native state. A terminal root cannot resume.");
  if (!association || association.missionId !== context.missionId || association.missionPath !== context.missionPath ||
      association.invocation !== context.invocation || association.root !== root ||
      typeof association.source !== "string" || typeof association.digest !== "string" ||
      !Number.isSafeInteger(association.maxCycles) || association.maxCycles < 1 ||
      !isDeepStrictEqual(association.sourceRefs, context.sourceRefs))
    throw new Error("Incompatible retained association; no settings admission.");
  return cursor;
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
      executionAmendments(observed.root, context.amendments, true);
      const { sourceRefs, agentDir } = context.admission;
      for (const ref of sourceRefs) {
        const content = readFileSync(ref.path, "utf8");
        validateSpec(content, path.basename(ref.path, ".md"));
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== ref.digest) throw new Error(`Complete spec source hash mismatch: ${ref.path}; expected ${ref.digest}, observed ${actual}`);
      }
      let admitted, recovery, checkpointObservation, timeoutRecovery, selectionRecovery, storeFailure, haltOriginal, initialAdvance;
      try {
        admitted = admittedInvocation(run, context);
        if (admitted) {
          const gap = earlyAnalysisReplayGap(admitted, context.missionPath, context.missionId);
          if (gap) {
            emitBounded(run, { version: 1, error: gap });
            return run.lines.join("\n");
          }
          recovery = boundRetainedAnalyses(observed.root, observed.commonDir, observed.source,
            observed.digest, observed.binding, context);
          if (admitted.halt?.stage !== "checkpoint-witness")
            checkpointObservation = observeCheckpoint({ root: observed.root, commonDir: observed.commonDir, selected: observed }, context);
          timeoutRecovery = boundExecuteTimeoutProjection(observed.root, context);
          selectionRecovery = readExecuteSelectionReplay(observed.root, admitted);
          haltOriginal = retainedExecuteHalt(observed.root, admitted);
        } else initialAdvance = readInitialAdvanceReplay(observed.root, context, observed);
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        storeFailure = { code: error.code, reason: error.message };
        if (error.code === "store-replaced")
          initialAdvance = boundEpochAdvanceReplay(observed.root, context, observed);
      }
      let admission;
      if (!admitted && !storeFailure && !initialAdvance) {
        if (!agentDir || !path.isAbsolute(agentDir)) throw new Error("Expected absolute host agent directory for settings admission.");
        const { executeMaxCycles, executeRevivalContextPeak, executeTaskReviewer, executeTaskSynthesis,
          DEFAULT_TASK_REVIEWER, DEFAULT_TASK_SYNTHESIS } = await import("../../extensions/execute-settings.ts");
        const maxCycles = executeMaxCycles(observed.root, agentDir);
        const revivalContextPeak = executeRevivalContextPeak(observed.root, agentDir);
        const taskReviewer = executeTaskReviewer(observed.root, agentDir);
        const taskSynthesis = executeTaskSynthesis(observed.root, agentDir);
        const { reviewModels } = await import("../../extensions/review-settings.ts");
        const models = reviewModels(observed.root, agentDir);
        admission = { maxCycles,
          ...(models.r1.model !== "anthropic/claude-opus-5-5:high" ||
            models.r2.model !== "openai-codex/gpt-6.1-sol:xhigh" ||
            models.synthesis.model !== "anthropic/claude-opus-5-5:high" ? { reviewModels: models } : {}),
          ...(taskReviewer !== DEFAULT_TASK_REVIEWER ? { taskReviewer } : {}),
          ...(taskSynthesis !== DEFAULT_TASK_SYNTHESIS ? { taskSynthesis } : {}),
          ...(revivalContextPeak !== 120000 ? { revivalContextPeak } : {}) };
      }
      const { head, fingerprint } = checkoutEvidence(observed.root);
      emitBounded(run, { version: 1, binding: observed.binding, checkout: { head, fingerprint }, ...(admission ? { admission } : {}),
        ...(recovery ? { recoveryDigest: recovery.digest } : {}), ...(checkpointObservation ? { checkpointObservation } : {}),
        ...(timeoutRecovery ? { timeoutDigest: timeoutRecovery.digest } : {}),
        ...(selectionRecovery ? { selectionRecovery } : {}), ...(storeFailure ? { storeFailure } : {}),
        ...(haltOriginal ? { haltOriginal } : {}), ...(initialAdvance ? { initialAdvance } : {}) });
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

export function observeCheckpoint(found: { root: string; commonDir: string; selected?: { source: string; digest: string } }, context: any) {
  let observation;
  if (context && found.selected) {
    let mission;
    try { mission = JSON.parse(readFileSync(executionStatePath(context), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (mission?.[EXECUTE_CURSOR_KEY] !== undefined) {
      const cursor = mission[EXECUTE_CURSOR_KEY];
      validateExecuteCursor(EXECUTE_CURSOR_KEY, cursor);
      if (cursor.invocation !== context.invocation) return undefined;
      if (cursor.loop?.phase !== "implementation" || !cursor.loop.attempt?.intent) return undefined;
      const { intent, records, confirmed } = readExecuteIntentContext(found.root, cursor);
      const association = intent.association;
      if (association.root !== found.root || association.commonDir !== found.commonDir ||
          association.source !== found.selected.source || association.digest !== found.selected.digest ||
          association.missionId !== context.missionId || association.missionPath !== context.missionPath ||
          !isDeepStrictEqual(association.sourceRefs, context.sourceRefs))
        throw new Error("Checkpoint observation association mismatch.");
      const subject = { key: intent.key, taskId: intent.taskId, attempt: intent.attempt,
        loop: intent.loop, cursor: intent.cursor };
      try {
        // Earlier captures may be the only surviving preimages of a resumed slot.
        // Only committed originals within this cursor's head can contribute.
        const earlier = records.flatMap(row => {
          const source = row.kind === "intent" ? row.body as Partial<ExecuteIntentBody> : undefined;
          return source && source.version === 2 && isDeepStrictEqual(source.association, association) &&
            source.taskId === intent.taskId && source.loop === intent.loop && source.cursor === intent.cursor &&
            source.phase === intent.phase && source.attempt! < intent.attempt ? [source as ExecuteIntentBody] : [];
        }).sort((a, b) => b.attempt - a.attempt);
        const sources = [intent, ...earlier.filter((source, index) =>
          earlier.findIndex(other => other.key === source.key) === index)];
        // The capture predates its result admission. Use logical progress at the
        // saved head so a later baseline cannot turn that same admission into new evidence.
        const admitted = structuredClone(intent.progress!.admitted);
        for (const row of records) {
          if (row.seq <= cursor.loop.attempt.intent.seq || row.kind !== "ledger") continue;
          for (const entry of (row.body as { entries: { kind: string; loop: number;
            body: { result?: { taskId: string; status: string }; results?: { taskId: string; status: string }[] } }[] }).entries) {
            if (entry.kind !== "unit" || entry.loop !== intent.loop) continue;
            for (const result of [...(entry.body.results ?? []), ...(entry.body.result ? [entry.body.result] : [])]) {
              const states = admitted[result.taskId] ??= [];
              if (!states.includes(result.status)) states.push(result.status);
            }
          }
        }
        observation = { ...subject, evidence: checkpointEvidence(sources,
          { consumedLoops: cursor.budget.consumedLoops, admitted }, confirmed?.kind === "unit" ? confirmed : undefined) };
      } catch (error) { observation = { ...subject, error: String(error instanceof Error ? error.message : error) }; }
      return observation;
    }

  }
  return observation;
}
