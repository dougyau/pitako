import { randomUUID } from "node:crypto";
import { cancelTeamWorker, cancelWorker, type LiveTarget } from "./background.ts";
import { listObservations } from "./observe.ts";
import { resolveOwnedLive } from "./owner.ts";
import { queryHistory, type HistoryQuery } from "./history-query.ts";
import { teamEvaluationForSession } from "../team.ts";
import type { AgentUiSnapshot } from "./ui.ts";

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
  let active = true;
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
    return listObservations(evaluation?.token, owner.sessionId);
  };
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
  return {
    revoke() {
      active = false; // before any caller's cleanup await
      for (const view of views) view.revoke();
    },
    async settle() { await Promise.allSettled([...pending]); },
    openView() {
      check();
      let connected = true, sensitiveHistory = false, sensitiveRoute = false, busy = false;
      const work = new Set<Promise<unknown>>();
      const lease = { revoke() { connected = false; } };
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
        list(after?: string) {
          ready();
          if (after !== undefined && !rows().some(row => row.id === after)) throw new Error("invalid list cursor");
          const items = [];
          const sorted = rows().sort((a, b) => a.id.localeCompare(b.id));
          const remaining = after ? sorted.slice(sorted.findIndex(row => row.id === after) + 1) : sorted;
          for (const row of remaining) {
            const item = { id: row.id, roleId: row.roleId, status: row.status, source: row.origin?.source,
              assignmentId: row.origin?.assignmentId, task: row.task.slice(0, 100), selectedModel: row.selectedModel,
              requestedModel: row.requestedModel, requestedReasoning: row.requestedReasoning,
              activated: row.activated, sdkRequest: currentRequest(row), acceptedAt: row.acceptedAt,
              terminalAt: row.terminalAt, activity: row.lastActivityKind, phase: row.phase,
              profile: row.origin?.routing?.profile };
            if (items.length === 50 || Buffer.byteLength(JSON.stringify([...items, item])) > 30 * 1024) break;
            items.push(item);
          }
          return { items: structuredClone(items), cursor: items.length < remaining.length ? String(items.at(-1)?.id) : null,
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
            identity: { coordinatorSessionId: owner.sessionId, source: row.origin?.source, assignmentId: row.origin?.assignmentId },
            workbrief: original,
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
        route(id: string, offset = 0) {
          ready();
          if (!sensitiveRoute) throw new Error("raw route requires this view's acknowledgement");
          return textPage(JSON.stringify(rowFor(id).origin?.routing ?? null), offset);
        },
        history(query: HistoryQuery, worker?: { instanceId: string }) {
          return own(async () => {
            if (query.action === "read" && !sensitiveHistory) throw new Error("raw history requires this view's acknowledgement");
            const row = worker ? rowFor(worker.instanceId) : undefined;
            const scope = { coordinatorSessionId: owner.sessionId, ...(row ? { instanceId: row.id,
              ...(row.origin?.assignmentId ? { assignmentId: row.origin.assignmentId } : {}) } : {}) };
            return queryHistory(query, owner.sessionId, undefined, scope);
          });
        },
        input(selection: AgentSelection, input: { intent: "query" | "steer"; text: string; decisionId?: string }) {
          return own(async () => {
            const binding = admit(selection); // no await between owner/native fence and local admission
            return binding.handle.input({ ...input, historyId: selection.historyId, sessionId: selection.sessionId });
          });
        },
        cancel(selection: AgentSelection) {
          ready();
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
