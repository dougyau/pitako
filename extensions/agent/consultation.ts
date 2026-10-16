import { randomUUID } from "node:crypto";
import { feedbackLinks, type ConsultationFeedbackInput } from "./consultation-feedback.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ClassifierContext, type ClassifierResult } from "@earendil-works/pi-ai";
import { discoverClassifier, invokeClassifier, RECORD_LIMIT } from "./routing.ts";
import { Type } from "typebox";
import { loadPitakoConfig, resolveRoleFromConfig } from "../roles/load.ts";
import { REASONING_LEVELS, isReasoningLevel, type PitakoConfig, type ReasoningLevel, type ResolvedRole } from "../roles/types.ts";
import { WorkerHistory, type HistoryOrigin, type ConsultationLocator } from "./history.ts";

export const CONSULTATION_ROLES = ["scout", "researcher", "oracle"] as const;
export type ConsultationRole = (typeof CONSULTATION_ROLES)[number];
export const isConsultation = (role: string): role is ConsultationRole => (CONSULTATION_ROLES as readonly string[]).includes(role);
export type ReasoningSelection = { mode: "default" } | { mode: "direct"; level: ReasoningLevel } | { mode: "classify" };
export const reasoningSchema = Type.Optional(Type.Union([
  Type.Object({ mode: Type.Literal("classify") }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("default") }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("direct"), level: Type.Union(REASONING_LEVELS.map(level => Type.Literal(level))) }, { additionalProperties: false }),
]));
export interface ConsultationSnapshot {
  config: PitakoConfig; role: ResolvedRole; selection: ReasoningSelection;
  configuredPrimary?: ResolvedRole["modelPolicy"]["primary"];
}
export function consultationSnapshot(roleId: string, reasoning: ReasoningSelection | undefined, cwd: string, config?: PitakoConfig): ConsultationSnapshot | undefined {
  if (!isConsultation(roleId)) {
    if (reasoning !== undefined) throw new Error("reasoning selection is only available for Scout, Researcher and Oracle");
    return undefined;
  }
  const selection = reasoning ?? { mode: "default" };
  if (!(selection.mode === "default" || selection.mode === "classify" || selection.mode === "direct" && isReasoningLevel(selection.level)))
    throw new Error("consultations support default, direct or classify reasoning");
  config ??= loadPitakoConfig({ cwd });
  const configured = structuredClone(resolveRoleFromConfig(config, roleId));
  if (configured.modelPolicy.primary) configured.modelPolicy.primary = { ...configured.modelPolicy.primary,
    configuredReasoning: { level: configured.modelPolicy.primary.reasoning } };
  const role = selection.mode !== "direct" || !configured.modelPolicy.primary ? configured : { ...configured, modelPolicy: {
    ...configured.modelPolicy, primary: { ...configured.modelPolicy.primary, reasoning: selection.level, directReasoning: true },
  } };
  return structuredClone({ config, role, configuredPrimary: configured.modelPolicy.primary, selection });
}

type ConsultationEvent = "decision" | "outcome" | "delivery" | "feedback" | "preparation" | "closure";


export interface ReasoningAdvice {
  classifier: PitakoConfig["developerRouting"];
  request?: ClassifierContext; response?: ClassifierResult; usage?: ClassifierResult["usage"] | null;
  reason: string; selected?: ReasoningLevel;
  startedAt: string; completedAt?: string; elapsedMs?: number;
  callStartedAt?: string; callCompletedAt?: string;
  evidence: "pending-native-persistence" | "unavailable";
}

/** One dispatch decision; ordinary failures retain the entire frozen primary. */
export async function prepareConsultation(snapshot: ConsultationSnapshot, task: string, ctx: ExtensionContext,
  signal: AbortSignal, check: () => void, record: ReturnType<typeof consultationRecord>): Promise<ConsultationSnapshot> {
  record.event("preparation", { state: "started" });
  check();
  if (snapshot.selection.mode !== "classify") { record.event("preparation", { state: "prepared" }); return snapshot; }
  const started = Date.now();
  const advice: ReasoningAdvice = { classifier: snapshot.config.developerRouting, reason: "classifier unavailable",
    startedAt: new Date(started).toISOString(), evidence: "pending-native-persistence" };
  let next = snapshot;
  try {
    const primary = snapshot.configuredPrimary;
    const slash = primary?.model.indexOf("/") ?? -1;
    const model = primary && slash > 0 ? ctx.modelRegistry.find(primary.model.slice(0, slash), primary.model.slice(slash + 1)) : undefined;
    const choices = model ? getSupportedThinkingLevels(model) : [];
    const context: ClassifierContext = { state: { role: snapshot.role.id, workbrief: task }, questions: { reasoning: {
      type: "choice", instructions: "Choose reasoning effort for this consultation role and submitted brief, not a model, role, Developer capacity or authority.",
      criteria: Object.fromEntries([...choices.map(level => [level, `Use the supported ${level} reasoning level.`]),
        ["indeterminate", "The brief does not establish a reasoning choice; retain the configured primary."]]),
    } } };
    if (!primary) advice.reason = "primary unavailable; classification skipped";
    else if (!model || choices.length < 2) advice.reason = "primary capabilities unavailable or empty; classification skipped";
    else if (!record.canRecord()) advice.reason = "native recording unavailable; classification skipped";
    else if (Buffer.byteLength(JSON.stringify(context)) > RECORD_LIMIT / 2) advice.reason = "submitted WorkBrief exceeds native request budget; classification skipped";
    else {
      const classifier = await discoverClassifier(ctx, snapshot.config.developerRouting, signal, check);
      check();
      if (classifier && (!Number.isFinite(classifier.contextWindow) || classifier.contextWindow <= 0)) advice.reason = "classifier capabilities unavailable; classification skipped";
      else if (classifier && Buffer.byteLength(JSON.stringify(context)) > classifier.contextWindow) advice.reason = "submitted WorkBrief exceeds conservative classifier context-window budget; classification skipped";
      else if (classifier) {
        advice.request = context;
        advice.callStartedAt = new Date().toISOString();
        try { advice.response = await invokeClassifier(ctx, classifier, context, signal, check); }
        finally { advice.callCompletedAt = new Date().toISOString(); }
        check();
        if (advice.response.stopReason === "aborted") throw new Error("Consultation classifier aborted before admission");
        const answer = advice.response.answers?.reasoning;
        if (advice.response.stopReason !== "stop") advice.reason = `classifier ${advice.response.stopReason}`;
        else if (!answer || answer.type !== "choice" || !answer.probabilities || typeof answer.probabilities !== "object") advice.reason = "malformed choice";
        else {
          const entries = Object.entries(answer.probabilities);
          const labels = [...choices, "indeterminate"];
          if (!labels.every(key => Object.hasOwn(answer.probabilities, key)) ||
              entries.some(([key, value]) => !labels.includes(key) || !Number.isFinite(value) || value < 0 || value > 1) ||
              !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) advice.reason = "malformed probabilities or unsupported labels";
          else {
            const highest = Math.max(...entries.map(([, value]) => value));
            const winners = entries.filter(([, value]) => value === highest);
            if (winners.length !== 1 || winners[0]![0] !== answer.choice) advice.reason = "tie or inconsistent choice";
            else if (!choices.includes(answer.choice as typeof choices[number])) advice.reason = "indeterminate choice";
            else { advice.selected = answer.choice as ReasoningLevel; advice.reason = "unique classifier choice"; }
          }
        }
      }
    }
  } catch (error) {
    check();
    if (advice.response?.stopReason === "aborted") { record.advice({ ...advice, reason: "classifier aborted; no admission" }); throw error; }
    advice.reason = `classifier failed: ${String(error)}`;
  }
  check();
  advice.completedAt = new Date().toISOString(); advice.elapsedMs = Date.now() - started;
  // Keep the complete result or explicitly discard all advice. Never clip a response.
  if (!record.advice(advice)) advice.selected = undefined;
  if (advice.selected && snapshot.configuredPrimary) next = { ...snapshot, role: { ...snapshot.role, modelPolicy: {
    ...snapshot.role.modelPolicy, primary: { ...snapshot.configuredPrimary, reasoning: advice.selected,
      classifiedReasoning: { configured: snapshot.configuredPrimary.reasoning } },
  } } };
  check();
  record.event("preparation", { state: "prepared" });
  return next;
}

/** Captured only at a native inline-extension boundary; no synthetic ExtensionContext. */
export function nativeCaller(pi: Pick<ExtensionAPI, "appendEntry">, ctx: Pick<ExtensionContext, "sessionManager">, current: () => boolean) {
  const manager = ctx.sessionManager, sessionId = manager.getSessionId?.(), sessionFile = manager.getSessionFile?.();
  const check = () => {
    if (!current() || ctx.sessionManager !== manager || manager.getSessionId?.() !== sessionId || manager.getSessionFile?.() !== sessionFile)
      throw new Error("native caller binding retired");
  };
  return { manager, sessionId, sessionFile, check,
    append(type: string, data: unknown) { check(); pi.appendEntry(type, data); } };
}
export type NativeCaller = ReturnType<typeof nativeCaller>;

/** Host-owned caller index. Native entries, not this catalog, remain the evidence. */
export function consultationRecord(pi: ExtensionAPI, ctx: ExtensionContext, origin: HistoryOrigin,
  dispatchId: string, instanceId: string, snapshot: ConsultationSnapshot, current: () => boolean, decisionId = randomUUID(), caller = ctx.sessionManager) {
  const capability = nativeCaller(pi, ctx, current);
  const callerSessionId = caller?.getSessionId?.();
  const callerSessionFile = caller?.getSessionFile?.();
  const retirementAuthorized = !!callerSessionId && !!callerSessionFile &&
    callerSessionId === (origin.callerSessionId ?? origin.coordinatorSessionId) && callerSessionFile === (origin.callerSessionFile ?? origin.coordinatorSessionFile);
  const store = new WorkerHistory();
  const group = origin.execution ? store.executionGroup(ctx.cwd, { kind: "execution", ...origin.execution }) : store.createGroup(ctx.cwd);
  const locator: ConsultationLocator = { dispatchId, instanceId, roleId: snapshot.role.id, toolCallId: origin.toolCallId,
    callerSessionId: origin.callerSessionId ?? origin.coordinatorSessionId, callerSessionFile: origin.callerSessionFile ?? origin.coordinatorSessionFile,
    coordinatorSessionId: origin.coordinatorSessionId, version: 1, decisionId,
    callerHeadInstanceId: origin.head?.headInstanceId, gaps: [], closure: { state: "pending" } };
  store.mutate(group.groupId, group => { if (!group.consultations) group.consultations = []; group.consultations.push(locator); });
  origin.consultation = { dispatchId, groupId: group.groupId, decisionId };
  const gap = (error: unknown) => {
    try { store.mutate(group.groupId, group => { group.consultations!.find(row => row.dispatchId === dispatchId)!.gaps.push(String(error).slice(0, 1024)); }); } catch { /* original gap remains live */ }
  };
  const append = (event: ConsultationEvent, data: unknown, authorized: () => boolean = current) => {
    try {
      if (!authorized() || ctx.sessionManager !== caller || caller?.getSessionId?.() !== callerSessionId ||
          caller?.getSessionFile?.() !== callerSessionFile || callerSessionId !== locator.callerSessionId ||
          callerSessionFile !== locator.callerSessionFile) throw new Error("caller binding retired; native event not appended");
      const record = { version: 1, event, dispatchId, role: snapshot.role.id, at: new Date().toISOString(), data };
      if (Buffer.byteLength(JSON.stringify(record)) > 262144) throw new Error("consultation record exceeds native budget");
      if (authorized === current) capability.append("pitako.consultation", record);
      else pi.appendEntry("pitako.consultation", record);
      return true;
    } catch (error) { gap(error); return false; }
  };
  let classification: ReasoningAdvice | undefined;
  const event = (kind: ConsultationEvent, data: unknown) => append(kind, data);
  event("decision", { ...(decisionId ? { decisionId } : {}), selection: snapshot.selection, primary: snapshot.role.modelPolicy.primary,
    fallbacks: snapshot.role.modelPolicy.fallbacks, evidence: "pending-native-persistence" });
  return { event,
    classification: () => classification,
    matchesCaller: (manager: unknown) => manager === caller,
    feedback(input: ConsultationFeedbackInput, receipt: () => boolean) {
      if (!current() || !receipt()) throw new Error("exact outcome is not incorporated in the current owner branch");
      const links = feedbackLinks(store, locator, input, member => locator.callerHeadInstanceId
        ? member.head?.headInstanceId === locator.callerHeadInstanceId && member.assignmentId === origin.assignmentId
        : member.coordinatorSessionId === locator.coordinatorSessionId && !member.head?.runId &&
          (!member.callerSessionId || member.callerSessionId === locator.callerSessionId));
      if (!current() || !receipt()) throw new Error("consultation feedback owner or branch retired");
      const data = { usefulness: input.usefulness, note: input.note, followupInstances: links,
        author: { callerSessionId, callerHeadInstanceId: locator.callerHeadInstanceId, assignmentId: origin.assignmentId },
        at: new Date().toISOString(), association: "observed linked consumption only; not a causal claim" };
      if (!append("feedback", data, () => current() && receipt())) throw new Error("feedback native append failed");
      store.mutate(group.groupId, group => { group.consultations!.find(row => row.dispatchId === dispatchId)!.followupInstances = links; });
      return { ...data, dispatchId, evidence: "pending-native-persistence" };
    },
    canRecord: () => !!callerSessionId && !!callerSessionFile && typeof pi.appendEntry === "function",
    advice(data: ReasoningAdvice) {
      classification = data;
      const value = { decisionId, selection: snapshot.selection, primary: snapshot.configuredPrimary,
        fallbacks: snapshot.role.modelPolicy.fallbacks, ...data };
      if (Buffer.byteLength(JSON.stringify(value)) > RECORD_LIMIT - 2048) {
        const usage = data.response?.usage && Buffer.byteLength(JSON.stringify(data.response.usage)) <= 8192 ? data.response.usage : null;
        classification = { ...data, request: undefined, response: undefined, selected: undefined, usage,
          reason: "complete advice exceeds native record budget; configured primary retained", evidence: "unavailable" };
        event("decision", { decisionId, selection: snapshot.selection, primary: snapshot.configuredPrimary,
          classifier: data.classifier, reason: classification.reason, callStartedAt: data.callStartedAt,
          callCompletedAt: data.callCompletedAt, completedAt: data.completedAt, elapsedMs: data.elapsedMs,
          classifierCallObserved: !!data.callStartedAt, usage, evidence: "unavailable" });
        return false;
      }
      return event("decision", value);
    },
    // Retirement revokes delivery, not the captured native caller's authority to record its own drop.
    retired() { return append("delivery", { state: "dropped" }, () => retirementAuthorized); },
    settled(unknown?: string) {
      event("closure", unknown ? { state: "unknown", reason: unknown } : { state: "released" });
      try {
        store.mutate(group.groupId, group => { group.consultations!.find(row => row.dispatchId === dispatchId)!.closure = unknown
          ? { state: "unknown", reason: unknown } : { state: "released" }; });
        if (!unknown) store.closeInvocation(group.groupId);
      } catch (error) { gap(error); }
    } };
}
