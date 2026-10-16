import { createHash, randomUUID } from "node:crypto";
import { cancelTeamWorker, cancelWorker, readWorkerResult, type LiveTarget } from "./background.ts";
import { listObservations, readTerminalActivity, subscribeChanges } from "./observe.ts";
import { resolveOwnedLive, resolveOwnedWorkerRead } from "./owner.ts";
import { queryHistory, type HistoryQuery } from "./history-query.ts";
import { teamEvaluationForSession } from "../team.ts";
import type { AgentUiSnapshot } from "./ui.ts";
import type { WorkerReadReference, WorkerReadCursor, PublicWorkerDetail } from "./bridge/protocol.js";

export interface AgentSelection {
  processId: string;
  coordinatorSessionId: string;
  epoch: string;
  target: LiveTarget;
  instanceId: string;
  generation: number;
  historyId: string;
  sessionId: string;
}
export interface AgentControllerOwner {
  sessionId: string;
  token: symbol;
}

const textPage = (text: string, offset = 0) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("invalid page offset");
  const part = text.slice(offset, offset + 1024);
  return { text: part, offset, nextOffset: offset + part.length < text.length ? offset + part.length : null };
};
function routeSummary(row: AgentUiSnapshot) {
  const route = row.origin?.routing;
  if (!route) return { state: row.roleId === "developer" ? "unavailable" : "not-routed" };
  const answer = route.response?.answers.capacity;
  const recommendation = answer?.type === "choice" ? { choice: answer.choice, probabilities: answer.probabilities } : undefined;
  return { state: "captured", dispatchId: route.dispatchId, profile: route.profile, reason: route.reason.slice(0, 1024),
    recommendation: recommendation && Buffer.byteLength(JSON.stringify(recommendation)) <= 8192 ? recommendation : undefined,
    recommendationAvailability: !recommendation ? "unavailable" : Buffer.byteLength(JSON.stringify(recommendation)) > 8192
      ? "oversized; use acknowledged raw route pages" : "available",
    evidence: row.origin?.routingEvidence ? { ...row.origin.routingEvidence, gap: row.origin.routingEvidence.gap?.slice(0, 1024) }
      : { state: "unavailable", gap: "No captured evidence availability" } };
}
const currentRequest = (row: AgentUiSnapshot) => [...row.sdkRequests ?? []].reverse().find(request => request.attemptId === row.attemptId) ?? null;

/** One foreground closure owns this controller. No shared controller registry or worker runtime. */
export function createAgentController(owner: AgentControllerOwner, current: () => AgentControllerOwner | undefined) {
  const processId = `${process.pid}:${randomUUID()}`, epoch = randomUUID();
  let teamIdentity: { token: symbol; id: string } | undefined;
  let active = true;
  let revision = 0;
  const listeners = new Set<(revision: number) => void>();
  const views = new Set<{ revoke(): void }>();
  const pending = new Set<Promise<unknown>>();
  const check = () => {
    const live = current();
    if (!active || live?.sessionId !== owner.sessionId || live.token !== owner.token)
      throw new Error("controller owner epoch is retired");
  };
  const rows = () => {
    check();
    const evaluation = teamEvaluationForSession(owner.sessionId, false);
    return listObservations(evaluation?.token, owner.sessionId).filter(row =>
      row.ownerToken === undefined || row.ownerToken === owner.token);
  };
  const unwatch = subscribeChanges(row => {
    const live = current();
    if (!active || live?.sessionId !== owner.sessionId || live.token !== owner.token ||
        row.origin?.coordinatorSessionId !== owner.sessionId ||
        row.ownerToken !== undefined && row.ownerToken !== owner.token ||
        !["agent_run", "agent_spawn", "team_assign"].includes(row.origin.source) ||
        row.teamOwnerToken && row.teamOwnerToken !== teamEvaluationForSession(owner.sessionId, false)?.token ||
        row.origin.source === "team_assign" && (!row.teamOwnerToken || !row.origin.assignmentId)) return;
    if (revision === Number.MAX_SAFE_INTEGER) {
      active = false; unwatch();
      for (const view of views) view.revoke();
      return;
    }
    revision++;
    for (const listener of listeners) {
      try { listener(revision); } catch { /* A host listener cannot affect worker execution. */ }
    }
  });
  const rowFor = (id: string) => {
    const row = rows().find(row => row.id === id);
    if (!row) throw new Error("unknown scoped worker");
    return row;
  };
  const targetFor = (row: AgentUiSnapshot): LiveTarget => row.origin?.source === "team_assign"
    ? { kind: "team", assignmentId: row.origin.assignmentId! } : { kind: "background", instanceId: row.id };
  const bindingFor = (row: AgentUiSnapshot) => {
    if (row.origin?.source === "agent_run") throw new Error("synchronous run is read-only");
    if (row.status !== "running") throw new Error("terminal worker is read-only");
    const target = targetFor(row);
    const binding = resolveOwnedLive(target, owner.sessionId);
    if (binding.instanceId !== row.id) throw new Error("live instance changed");
    const native = binding.handle.observe();
    if (native.active !== true) throw new Error("native binding is closed or stale");
    return { ...binding, target };
  };
  const selectionFor = (row: AgentUiSnapshot) => {
    const binding = bindingFor(row);
    return { processId, coordinatorSessionId: owner.sessionId, epoch, target: binding.target,
      instanceId: row.id, generation: binding.generation, historyId: binding.handle.historyId,
      sessionId: binding.handle.sessionId } satisfies AgentSelection;
  };
  const admit = (selection: AgentSelection) => {
    check();
    if (selection.processId !== processId || selection.coordinatorSessionId !== owner.sessionId || selection.epoch !== epoch)
      throw new Error("stale controller selection");
    const binding = bindingFor(rowFor(selection.instanceId));
    if (JSON.stringify(binding.target) !== JSON.stringify(selection.target) || binding.generation !== selection.generation ||
      binding.handle.historyId !== selection.historyId || binding.handle.sessionId !== selection.sessionId)
      throw new Error("live binding changed; reobserve");
    return binding;
  };
  const readScope = () => ({ coordinatorSessionId: owner.sessionId, ownerToken: owner.token,
    teamToken: teamEvaluationForSession(owner.sessionId, false)?.token });
  const referenceFor = (row: AgentUiSnapshot): WorkerReadReference => {
    const source = row.origin?.source;
    if (source !== "agent_run" && source !== "agent_spawn" && source !== "team_assign") throw new Error("unknown_target");
    let evaluationId: string | undefined;
    if (source === "team_assign") {
      const token = readScope().teamToken;
      if (!token || token !== row.teamOwnerToken) throw new Error("unknown_target");
      if (teamIdentity?.token !== token) teamIdentity = { token, id: randomUUID() };
      evaluationId = teamIdentity.id;
    }
    const binding = source === "agent_run" ? undefined : resolveOwnedWorkerRead(targetFor(row), readScope());
    const key = binding?.key;
    return { kind: "read", processId, coordinatorSessionId: owner.sessionId, epoch, instanceId: row.id, source,
      ...(source === "team_assign" ? { assignmentId: row.origin!.assignmentId!, evaluationId } : {}),
      ...(row.attemptId ? { attemptId: row.attemptId } : {}),
      ...(key ? { native: { generation: key.generation, historyId: key.historyId, sessionId: key.sessionId } } : {}) };
  };
  const readRow = (ref: WorkerReadReference) => {
    check();
    if (ref.kind !== "read" || ref.processId !== processId || ref.coordinatorSessionId !== owner.sessionId || ref.epoch !== epoch)
      throw new Error("stale_reference");
    const row = rowFor(ref.instanceId);
    const now = referenceFor(row);
    if (now.source !== ref.source || now.assignmentId !== ref.assignmentId || now.evaluationId !== ref.evaluationId ||
        now.attemptId !== ref.attemptId || now.native?.generation !== ref.native?.generation ||
        now.native?.historyId !== ref.native?.historyId || now.native?.sessionId !== ref.native?.sessionId)
      throw new Error("stale_reference");
    return row;
  };
  // Public references name a logical invocation or captured session, not current control admission.
  const publicRef = (row: AgentUiSnapshot): WorkerReadReference => {
    return { kind: "read", processId, coordinatorSessionId: owner.sessionId, epoch, instanceId: row.id,
      source: row.origin?.source ?? "agent_spawn", ...(row.origin?.assignmentId ? { assignmentId: row.origin.assignmentId } : {}) };
  };
  const publicRow = (ref: WorkerReadReference) => {
    check();
    const row = rowFor(ref.instanceId);
    const expected = publicRef(row);
    if (ref.kind !== expected.kind || ref.processId !== expected.processId || ref.coordinatorSessionId !== expected.coordinatorSessionId ||
      ref.epoch !== expected.epoch || ref.source !== expected.source || ref.assignmentId !== expected.assignmentId ||
      ref.attemptId !== undefined || ref.evaluationId !== undefined) throw new Error("stale_reference");
    return row;
  };
  const offsetFor = (ref: WorkerReadReference, cursor: WorkerReadCursor | undefined, section: WorkerReadCursor["section"]) => {
    if (!cursor) return 0;
    readRow(cursor.ref);
    if (JSON.stringify(cursor.ref) !== JSON.stringify(ref) || cursor.section !== section ||
        !("offset" in cursor) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("invalid_cursor");
    return cursor.offset;
  };
  const nextText = (ref: WorkerReadReference, section: "brief" | "detail_metadata" | "result_text" | "result_metadata",
    page: ReturnType<typeof textPage>): WorkerReadCursor | null =>
    page.nextOffset === null ? null : { ref, section, offset: page.nextOffset };
  return {
    revoke() {
      active = false; // before any caller's cleanup await
      unwatch();
      for (const view of views) view.revoke();
    },
    async settle() { await Promise.allSettled([...pending]); },
    openView(options: { control?: boolean; policy?: "bridge-read" } = {}) {
      check();
      let connected = true, sensitiveHistory = false, sensitiveRoute = false, busy = false;
      const control = options.control !== false && options.policy !== "bridge-read";
      const work = new Set<Promise<unknown>>();
      let unsubscribe: (() => void) | undefined;
      const lease = { revoke() { connected = false; unsubscribe?.(); } };
      views.add(lease);
      const ready = () => { check(); if (!connected) throw new Error("view is disconnected"); };
      const own = <T>(operation: () => Promise<T>): Promise<T> => {
        ready();
        if (busy) throw new Error("view has outstanding work");
        busy = true;
        const accepted = Promise.resolve().then(() => { ready(); return operation(); });
        work.add(accepted); pending.add(accepted);
        const release = () => { work.delete(accepted); pending.delete(accepted); busy = false; };
        accepted.then(release, release);
        return accepted.then(result => { ready(); return result; });
      };
      return {
        readPublicDetail(id: string, cursor?: WorkerReadCursor): PublicWorkerDetail | { state: "unavailable"; reason: "unsupported_kind" } {
          ready();
          if (cursor?.ref.native) throw new Error("invalid_cursor");
          const row = cursor ? publicRow(cursor.ref) : rowFor(id);
          if (row.id !== id) throw new Error("invalid_cursor");
          if (row.origin?.source !== "agent_spawn" && row.origin?.source !== "team_assign")
            return { state: "unavailable", reason: "unsupported_kind" };
          const ref = publicRef(row);
          if (cursor && cursor.section !== "brief" && cursor.section !== "public_bindings") throw new Error("invalid_cursor");
          const outcome = readWorkerResult(targetFor(row), readScope());
          const conversation = resolveOwnedWorkerRead(targetFor(row), readScope()).conversation;
          const capture = conversation?.metadata(ref);
          const workbrief = { ...textPage(row.origin?.workbrief ?? row.task,
            cursor?.section === "brief" ? cursor.offset : 0),
            source: row.origin?.workbrief === undefined ? "invocation task" as const : "original WorkBrief" as const };
          const start = cursor?.section === "public_bindings" ? cursor.offset : 0;
          if (!Number.isSafeInteger(start) || start < 0 || start > (capture?.bindings.length ?? 0)) throw new Error("invalid_cursor");
          const bindings = [];
          for (const binding of capture?.bindings.slice(start) ?? []) {
            if (bindings.length >= 50 || Buffer.byteLength(JSON.stringify([...bindings, binding])) > 24 * 1024) break;
            bindings.push(binding);
          }
          return { format: "public-v1", ref,
            worker: { ...(row.teamId ? { teamId: row.teamId } : {}), ...(row.memberId ? { memberId: row.memberId } : {}),
              ...(row.turnId ? { turnId: row.turnId } : {}), source: row.origin.source, instanceId: row.id, roleId: row.roleId,
              coordinatorSessionId: row.origin?.coordinatorSessionId ?? null, toolCallId: row.origin?.toolCallId ?? null,
              ...(row.origin?.assignmentId ? { assignmentId: row.origin.assignmentId } : {}),
              acceptedAt: row.acceptedAt, linkage: row.origin?.toolCallId ? "tool" : "unlinked" },
            lifecycle: { execution: outcome.state === "ready" ? outcome.status : row.status === "created" ? "accepted" : row.status,
              result: outcome.state === "ready" ? "available" : ["completed", "failed", "cancelled"].includes(row.status) ? "unavailable" : "pending",
              capture: capture?.capture ?? "incomplete", captureReason: capture?.captureReason ?? (capture ? undefined : "not_captured"),
              finalSequence: capture?.finalSequence },
            bindings, captureEpoch: capture?.epoch, conversationSequence: capture?.sequence, captureGaps: capture?.gaps,
            nextBindings: start + bindings.length < (capture?.bindings.length ?? 0)
              ? { ref, section: "public_bindings", offset: start + bindings.length } : null,
            workbrief, nextBrief: nextText(ref, "brief", workbrief),
            selected: { model: row.selectedModel, requestedModel: row.requestedModel, reasoning: row.requestedReasoning },
            activated: row.activated ?? null,
          };
        },
        readPublicActivity(ref: WorkerReadReference, cursor?: string, recovery = false, byteBudget?: number) {
          ready();
          const row = publicRow(ref);
          if (row.origin?.source === "agent_run") return { state: "unavailable" as const, reason: "unsupported_kind" as const };
          const conversation = resolveOwnedWorkerRead(targetFor(row), readScope()).conversation;
          if (!conversation) return { state: "unavailable" as const, reason: "not_captured" as const };
          return conversation.read(ref, cursor, recovery, byteBudget);
        },
        readPublicResult(ref: WorkerReadReference, cursor?: WorkerReadCursor) {
          ready();
          const row = publicRow(ref);
          if (row.origin?.source === "agent_run") return { state: "unavailable" as const, reason: "unsupported_kind" as const };
          if (ref.native && !resolveOwnedWorkerRead(targetFor(row), readScope()).conversation?.hasBinding(ref))
            throw new Error("unknown_target");
          if (cursor && (cursor.section !== "result_text" || JSON.stringify(cursor.ref) !== JSON.stringify(ref)))
            throw new Error("invalid_cursor");
          const result = readWorkerResult(targetFor(row), readScope(), {
            offset: cursor?.section === "result_text" ? cursor.offset : 0 });
          if (result.state !== "ready") return result;
          return { format: "public-v1" as const, state: "ready" as const, ref, status: result.status,
            text: result.text, nextText: nextText(ref, "result_text", result.text) };
        },
        subscribe(listener: (revision: number) => void) {
          ready();
          if (unsubscribe || listeners.size >= 8) throw new Error("busy");
          const receive = (revision: number) => listener(revision);
          listeners.add(receive);
          let installed = true;
          const dispose = () => {
            if (!installed) return;
            installed = false;
            listeners.delete(receive); unsubscribe = undefined;
          };
          unsubscribe = dispose;
          try {
            // No await between installation and projection. A later change is a hint.
            // Subscription replies encode the owner twice (envelope and snapshot).
            return { snapshot: this.list(undefined, undefined, 24 * 1024), get active() { return installed; }, dispose };
          } catch (error) { dispose(); throw error; }
        },
        readDetail(id: string, cursor?: WorkerReadCursor) {
          ready();
          const row = cursor ? readRow(cursor.ref) : rowFor(id);
          if (row.id !== id) throw new Error("invalid_cursor");
          const ref = referenceFor(row);
          if (cursor && cursor.section !== "brief" && cursor.section !== "detail_metadata") throw new Error("invalid_cursor");
          const outcome = row.origin?.source === "agent_run" ? { state: "unavailable" as const, reason: "unsupported_kind" }
            : readWorkerResult(targetFor(row), readScope());
          const metadata = textPage(JSON.stringify({ id: row.id, roleId: row.roleId, source: row.origin?.source,
            teamId: row.teamId, memberId: row.memberId, turnId: row.turnId,
            assignmentId: row.origin?.assignmentId, task: row.task, handoff: row.handoff, resultTaken: row.resultTaken,
            selected: { model: row.selectedModel, requestedModel: row.requestedModel, reasoning: row.requestedReasoning,
              fast: { state: "unavailable", reason: "Fast intent is not retained in the selected-settings observation" } },
            activated: row.activated ?? { state: "unavailable", reason: "No observed activation for this attempt" },
            sdkRequest: currentRequest(row) ?? { state: "unavailable", reason: "No SDK-observed request for this attempt" },
            routeSummary: routeSummary(row), routing: { raw: "denied" }, history: { raw: "denied" },
            diagnostics: outcome.state === "ready" && outcome.status !== row.status
              ? ["Authoritative settled outcome differs from earlier display observation; close/disposal may have failed."] : [],
          }), cursor?.section === "detail_metadata" ? offsetFor(ref, cursor, "detail_metadata") : 0);
          const workbrief = { ...textPage(row.origin?.workbrief ?? row.task,
            cursor?.section === "brief" ? offsetFor(ref, cursor, "brief") : 0),
            source: row.origin?.workbrief === undefined ? "invocation task" : "original WorkBrief" };
          return { state: "ready" as const, ref, status: outcome.state === "ready" ? outcome.status : row.status,
            observedStatus: row.status, result: outcome.state,
            activity: ref.native ? "observed_binding" : "unavailable",
            metadata, workbrief, nextMetadata: nextText(ref, "detail_metadata", metadata),
            nextBrief: nextText(ref, "brief", workbrief) };
        },
        readRequests(id: string, cursor?: WorkerReadCursor) {
          ready();
          const row = cursor ? readRow(cursor.ref) : rowFor(id);
          if (row.id !== id) throw new Error("invalid_cursor");
          const ref = referenceFor(row);
          const projection = JSON.stringify({ requests: row.sdkRequests ?? [], dropped: row.sdkRequestsDropped ?? 0,
            missingReason: row.sdkRequests?.length ? undefined : "No SDK-observed request; selected settings are not observations.",
            returnedServiceTier: "unavailable", coverage: "SDK options only; provider internals are unavailable" });
          const digest = createHash("sha256").update(projection).digest("hex");
          const offset = offsetFor(ref, cursor, "requests");
          if (cursor && (!("digest" in cursor) || cursor.digest !== digest)) throw new Error("stale_cursor");
          const page = textPage(projection, offset);
          return { state: "ready" as const, ref, page,
            next: page.nextOffset === null ? null : { ref, section: "requests" as const, offset: page.nextOffset, digest } };
        },
        readActivity(ref: WorkerReadReference, cursor?: WorkerReadCursor) {
          ready();
          const row = readRow(ref);
          if (cursor) {
            readRow(cursor.ref);
            if (JSON.stringify(cursor.ref) !== JSON.stringify(ref) || cursor.section !== "activity" ||
                !Number.isSafeInteger(cursor.after) || cursor.after < 0) throw new Error("invalid_cursor");
          }
          if (row.origin?.source === "agent_run") return { state: "unavailable" as const, reason: "unsupported_kind" };
          const binding = resolveOwnedWorkerRead(targetFor(row), readScope());
          if (!binding.key) return { state: "unavailable" as const, reason: "not_captured" };
          const options = { after: cursor?.section === "activity" ? cursor.after : undefined, limit: 50 };
          const result = binding.handle ? { state: "ready" as const, page: binding.handle.observe(options) }
            : readTerminalActivity(binding.key, options);
          if (result.state !== "ready") return result;
          return { ...result, ref, next: { ref, section: "activity" as const, after: result.page.cursor as number } };
        },
        readResult(ref: WorkerReadReference, cursor?: WorkerReadCursor) {
          ready();
          const row = readRow(ref);
          if (cursor && cursor.section !== "result_text" && cursor.section !== "result_metadata") throw new Error("invalid_cursor");
          if (row.origin?.source === "agent_run") return { state: "unavailable" as const, reason: "unsupported_kind" };
          const result = readWorkerResult(targetFor(row), readScope(), {
            offset: cursor?.section === "result_text" ? offsetFor(ref, cursor, "result_text") : 0,
            metadataOffset: cursor?.section === "result_metadata" ? offsetFor(ref, cursor, "result_metadata") : 0,
          });
          if (result.state !== "ready") return result;
          return { ...result, ref, nextText: nextText(ref, "result_text", result.text),
            nextMetadata: nextText(ref, "result_metadata", result.metadata) };
        },
        async close() {
          lease.revoke();
          await Promise.allSettled([...work]);
          views.delete(lease);
        },
        acknowledge(kind: "history" | "route") {
          ready();
          if (kind === "history") sensitiveHistory = true;
          else if (kind === "route") sensitiveRoute = true;
          else throw new Error("unknown sensitive content kind");
        },
        list(after?: string, expectedRevision?: number, byteBudget = 30 * 1024) {
          ready();
          if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error("stale_cursor");
          if (after !== undefined && !rows().some(row => row.id === after)) throw new Error("invalid list cursor");
          const items = [];
          const sorted = rows().sort((a, b) => a.id.localeCompare(b.id));
          const remaining = after ? sorted.slice(sorted.findIndex(row => row.id === after) + 1) : sorted;
          for (const row of remaining) {
            const item = { id: row.id, roleId: row.roleId, status: row.status, source: row.origin?.source,
              teamId: row.teamId, memberId: row.memberId, turnId: row.turnId,
              assignmentId: row.origin?.assignmentId, task: row.task.slice(0, 100), selectedModel: row.selectedModel,
              requestedModel: row.requestedModel, requestedReasoning: row.requestedReasoning,
              activated: row.activated, sdkRequest: currentRequest(row), acceptedAt: row.acceptedAt,
              terminalAt: row.terminalAt, activity: row.lastActivityKind, phase: row.phase,
              profile: row.origin?.routing?.profile, resultTaken: row.resultTaken,
              handoff: row.handoff && { collection: row.handoff.collection, bookkeeping: row.handoff.bookkeeping,
                delivery: row.handoff.delivery, continuation: row.handoff.continuation } };
            if (items.length === 50) break;
            if (Buffer.byteLength(JSON.stringify([...items, item])) > byteBudget) {
              if (!items.length) throw new RangeError("worker metadata exceeds list page budget");
              break;
            }
            items.push(item);
          }
          return { revision, items: structuredClone(items), cursor: items.length < remaining.length ? String(items.at(-1)?.id) : null,
            owner: { processId, coordinatorSessionId: owner.sessionId, epoch } };
        },
        detail(id: string, briefOffset = 0, activityAfter?: number) {
          ready();
          const row = rowFor(id);
          let selection: AgentSelection | undefined, reason: string | undefined;
          try { selection = selectionFor(row); } catch (error) { reason = String(error); }
          let original = { ...textPage(row.origin?.workbrief ?? "", briefOffset), source: "original WorkBrief" };
          const observation = selection ? admit(selection).handle.observe({ briefOffset, after: activityAfter, limit: 50 }) : null;
          if (selection) {
            const page = observation?.workbrief;
            if (!page || typeof page !== "object" || !("text" in page) || typeof page.text !== "string" ||
              !("offset" in page) || typeof page.offset !== "number" ||
              !("nextOffset" in page) || !(page.nextOffset === null || typeof page.nextOffset === "number"))
              throw new Error("native original brief page unavailable");
            original = { text: page.text, offset: page.offset, nextOffset: page.nextOffset, source: "original WorkBrief" };
          }
          return structuredClone({ id: row.id, roleId: row.roleId, status: row.status, observation,
            identity: { coordinatorSessionId: owner.sessionId, source: row.origin?.source, assignmentId: row.origin?.assignmentId,
              teamId: row.teamId, memberId: row.memberId, turnId: row.turnId },
            workbrief: original, resultTaken: row.resultTaken, handoff: row.handoff,
            teamWrapper: row.origin?.source === "team_assign" ? row.task.split("\nWorkBrief:")[0]!.slice(0, 1024) : undefined,
            route: routeSummary(row), selected: { model: row.selectedModel, reasoning: row.requestedReasoning,
              requestedModel: row.requestedModel, attemptId: row.attemptId },
            activated: row.activated ?? null, sdkRequest: currentRequest(row),
            sdkRequestsDropped: row.sdkRequestsDropped ?? 0,
            controls: selection ? { available: true, selection } : { available: false, reason } });
        },
        observe(selection: AgentSelection, options?: { after?: number; limit?: number; briefOffset?: number }) {
          ready();
          return structuredClone(admit(selection).handle.observe(options));
        },
        requests(id: string, offset = 0) {
          ready();
          return textPage(JSON.stringify({ requests: rowFor(id).sdkRequests ?? [], dropped: rowFor(id).sdkRequestsDropped ?? 0 }), offset);
        },
        route(id: string, offset = 0, includeState = false) {
          ready();
          if (options.policy !== "bridge-read" && !sensitiveRoute) throw new Error("raw route requires this view's acknowledgement");
          const row = rowFor(id);
          return { ...textPage(JSON.stringify(row.origin?.routing ?? null), offset),
            ...(includeState ? { state: routeSummary(row).state } : {}) };
        },
        history(query: HistoryQuery, worker?: { instanceId: string }, byteBudget?: number) {
          return own(async () => {
            if (query.action === "read" && options.policy !== "bridge-read" && !sensitiveHistory) throw new Error("raw history requires this view's acknowledgement");
            const row = worker ? rowFor(worker.instanceId) : undefined;
            const scope = { coordinatorSessionId: owner.sessionId, ...(row ? { instanceId: row.id,
              ...(row.origin?.assignmentId ? { assignmentId: row.origin.assignmentId } : {}) } : {}) };
            return queryHistory(query, owner.sessionId, undefined, scope, byteBudget);
          });
        },
        input(selection: AgentSelection, input: { intent: "query" | "steer"; text: string; decisionId?: string },
          receipt?: (result: Record<string, unknown>) => void) {
          return own(async () => {
            if (!control) throw new Error("forbidden");
            const binding = admit(selection); // no await between owner/native fence and local admission
            const result = await binding.handle.input({ ...input, historyId: selection.historyId, sessionId: selection.sessionId });
            // Native evidence survives a disconnected view; own() still fences the caller's return.
            receipt?.(result);
            return result;
          });
        },
        cancel(selection: AgentSelection) {
          ready();
          if (!control) throw new Error("forbidden");
          if (busy) throw new Error("view has outstanding work");
          const binding = admit(selection);
          const target = binding.target;
          if (target.kind === "team") {
            const evaluation = teamEvaluationForSession(owner.sessionId, false);
            if (!evaluation) throw new Error("Team evaluation is retired");
            cancelTeamWorker(evaluation.token, binding.instanceId);
          } else cancelWorker(binding.instanceId);
          return { status: "requested", instanceId: binding.instanceId, historyId: selection.historyId, sessionId: selection.sessionId };
        },
      };
    },
  };
}
