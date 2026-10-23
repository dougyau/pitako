import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import { statusOwner, liveProducer, runActivityObserver, type AttemptRecord, type StatusReadAuthority, type ResourceRef, type Producer } from "./workflow-engine.ts";
import { currentWorkspace } from "./board/workspace.ts";
import { WorkflowState, resourceRef, type Activity, type Phase, type Reservation, type Resource, type RunRecord } from "./workflow-state.ts";

export type ActivityStatusSnapshot = {
  runId: string; activity: Activity; phase: Phase | null; ownerEpoch: number; phaseEpoch: number;
  stateVersion: number; asOf: string; lastFactAt: string | null;
  state: "active" | "waiting" | "blocked" | "retiring" | "completed" | "interrupted";
  wait: { kind: "live"; producerRef: ResourceRef } | { kind: "unknown"; reason: string } | null;
  diagnostics: readonly { scope: string; reason: string }[];
  attempts: readonly { dispatchId: string; instanceId: string; roleId: string;
    outcome: AttemptRecord["outcome"] | null; resource: ResourceRef; closure: "closed" | "unknown" | "open" }[];
  evidence: readonly { resource: ResourceRef; adapter: string; scopes: Resource["scopes"];
    facts: Resource["facts"]; closure: "closed" | "unknown" | "open" }[];
  restrictions: readonly { reservationId: string; kind: Reservation["kind"]; paths: readonly string[];
    state: "active" | "unknown"; reason: string | null }[];
  lastResult: { dispatchId: string; outcome: AttemptRecord["outcome"] | null; closure: "closed" | "unknown" | "open" } | null;
  delivery: readonly { key: string; state: string }[];
  projections: readonly { sequence: number; state: string; diagnostic?: string }[];
  cold: boolean; limits: readonly string[];
};
export type ActivityStatusEvent = { kind: "transition" | "heartbeat"; sequence: number; snapshot: ActivityStatusSnapshot };
type Observer = (event: ActivityStatusEvent) => unknown;
type Clock = { now(): number; every(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
const clock: Clock = {
  now: Date.now, every: (callback, ms) => { const timer = setInterval(callback, ms); timer.unref(); return timer; },
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};
type Receiver = { receive: Observer; busy: boolean; latest?: ActivityStatusEvent; active: boolean };
type Stream = {
  observers: Map<Observer, Receiver>; pending: Set<Promise<unknown>>; timer?: unknown; stop: () => void; resource: Producer;
  sequence: number; closed: boolean; clock: Clock; diagnostics: string[];
};
const streams = new WeakMap<object, Stream>();
const callbacks = new AsyncLocalStorage<{ stream: Stream; pending: Promise<void> }>();

export function getActivityStatus(read: StatusReadAuthority, now = Date.now()): ActivityStatusSnapshot {
  const owner = statusOwner(read);
  const run = owner.store.get<RunRecord>("runs", read.runId);
  if (!run) throw new Error("activity status unavailable");
  return snapshot(owner.store, run, false, now, !owner.active);
}

/** Cold query reads the committed journal; it makes no live-owner or process claim. */
export function readActivityStatus(root: string, runId?: string, now = Date.now()): ActivityStatusSnapshot | null {
  const workspace = currentWorkspace(root);
  if (!existsSync(path.join(workspace, ".pitako", "runs", "workflow-state.sqlite"))) return null;
  const store = new WorkflowState(workspace);
  try {
    const runs = store.all<RunRecord>("runs");
    const run = runId ? runs.find(item => item.runId === runId) : runs.at(-1);
    return run ? snapshot(store, run, true, now) : null;
  } finally { store.close(); }
}

function snapshot(store: WorkflowState, run: RunRecord, cold: boolean, now: number, retired = false): ActivityStatusSnapshot {
  const resources = store.all<Resource>("resources").filter(r => r.runId === run.runId && r.purpose !== "observation");
  const closure = (resource: Resource): "closed" | "unknown" | "open" =>
    store.closureReceipt(resource) ? "closed" : Object.values(resource.facts).includes("unknown") ? "unknown" : "open";
  const restrictions = store.all<Reservation>("reservations").filter((r): r is Reservation & { state: "active" | "unknown" } =>
    r.runId === run.runId && r.state !== "released" && !r.exclusionRetired && r.purpose !== "observation");
  const attempts = store.all<AttemptRecord>("attempts").flatMap(attempt => {
    const resource = resources.find(r => r.resourceId === attempt.resource.resourceId);
    return resource ? [{ dispatchId: attempt.dispatchId, instanceId: attempt.instanceId, roleId: attempt.roleId,
      outcome: attempt.outcome ?? null, resource: resourceRef(resource), closure: closure(resource) }] : [];
  });
  const last = attempts.at(-1);
  return {
    runId: run.runId, activity: run.activity, phase: run.phase, ownerEpoch: run.epoch, phaseEpoch: run.phaseEpoch,
    stateVersion: run.version, asOf: new Date(now).toISOString(), lastFactAt: run.lastFactAt,
    state: retired && !["completed", "retiring"].includes(run.state) ? "interrupted" : run.state,
    wait: run.state === "waiting" ? !cold && !retired && run.waitRef && liveProducer(run.waitRef)
      ? { kind: "live", producerRef: run.waitRef } : { kind: "unknown", reason: "no accredited local producer" } : null,
    diagnostics: restrictions.filter(r => r.state === "unknown").map(r => ({ scope: r.reservationId, reason: r.reason ?? "closure unknown" })),
    attempts,
    evidence: resources.map(resource => ({ resource: resourceRef(resource), adapter: resource.adapter,
      scopes: resource.scopes, facts: resource.facts, closure: closure(resource) })),
    restrictions: restrictions.map(r => ({ reservationId: r.reservationId, kind: r.kind, paths: r.paths, state: r.state, reason: r.reason })),
    lastResult: last ? { dispatchId: last.dispatchId, outcome: last.outcome, closure: last.closure } : null,
    delivery: store.all<{ kind?: string; runId?: string; key: string; state: string }>("obligations")
      .filter(item => item.kind === "phase-turn" && item.runId === run.runId)
      .map(({ key, state }) => ({ key, state })),
    projections: store.outbox().filter(item => item.target === `disposition:${run.runId}` &&
      (item.body as { choice?: { kind?: string } }).choice?.kind === "user-decision")
      .map(item => ({ sequence: item.sequence, state: item.state,
        diagnostic: (item.body as { projectionDiagnostic?: string }).projectionDiagnostic })),
    cold, limits: cold ? ["Stored status does not prove a live owner or physical closure; inspect exact receipts and restrictions."] : [],
  };
}

/** A single read-only emitter per live owner. It never creates a turn or business fact. */
export function subscribeActivityStatus(read: StatusReadAuthority, observer: Observer, timing: Clock = clock) {
  const owner = statusOwner(read);
  if (!owner.active) throw new Error("activity owner retired");
  let stream = streams.get(owner);
  if (!stream) {
    const resource = owner.observation();
    resource.enter();
    const created: Stream = { observers: new Map(), pending: new Set(), sequence: 0, resource,
      closed: false, clock: timing, diagnostics: [], stop: () => {} };
    stream = created;
    streams.set(owner, stream); // Own the emitter before admitting a timer/callback.
    const emit = (kind: ActivityStatusEvent["kind"]) => {
      if (created.closed || !owner.active || !created.observers.size) return;
      const event = { kind, sequence: ++created.sequence, snapshot: getActivityStatus(read, timing.now()) };
      const receivers = [...created.observers.values()];
      // Publish to all receivers before entry: reentrant emissions must not be overwritten by this older event.
      for (const receiver of receivers) receiver.latest = structuredClone(event);
      for (const receiver of receivers) {
        if (!receiver.active || receiver.busy || !receiver.latest) continue; // One pending snapshot per observer.
        receiver.busy = true;
        const accepted = Promise.withResolvers<void>();
        created.pending.add(accepted.promise); // Register before invoking even a synchronous observer.
        void callbacks.run({ stream: created, pending: accepted.promise }, async () => {
          try {
            while (receiver.active && !created.closed && owner.active && receiver.latest) {
              const next = receiver.latest; receiver.latest = undefined;
              try { await runActivityObserver(read, async () => { await receiver.receive(next); }); }
              catch (error) {
                created.diagnostics.push(String(error)); created.diagnostics.splice(0, Math.max(0, created.diagnostics.length - 16));
              }
            }
          } finally {
            receiver.busy = false; created.pending.delete(accepted.promise); accepted.resolve();
          }
        });
      }
    };
    created.stop = owner.store.subscribe(() => emit("transition"));
    owner.retire.add(async () => {
      created.closed = true;
      if (created.timer !== undefined) timing.clear(created.timer);
      created.timer = undefined;
      created.stop();
      while (created.pending.size) await Promise.allSettled([...created.pending]);
      created.observers.clear();
      if (created.resource.live) created.resource.observe("callback", "closed", true);
    });
    created.observers.set(observer, { receive: observer, active: true, busy: false });
    created.timer = timing.every(() => emit("heartbeat"), 120_000);
  } else stream.observers.set(observer, { receive: observer, active: true, busy: false });
  let closing: Promise<void> | undefined;
  return {
    /** Inside an accepted callback this acknowledges the request, never settlement.
     * External callers (including repeat close) join the accepted work before `closed`. */
    async close(): Promise<{ kind: "requested" | "closed" }> {
      if (!closing) {
        const receiver = stream.observers.get(observer);
        if (receiver) { receiver.active = false; receiver.latest = undefined; }
        stream.observers.delete(observer);
        if (!stream.observers.size) {
          if (stream.timer !== undefined) stream.clock.clear(stream.timer);
          stream.timer = undefined;
          stream.stop(); stream.closed = true; streams.delete(owner);
        }
        closing = (async () => {
          while (stream.pending.size) await Promise.allSettled([...stream.pending]);
          if (stream.closed && stream.resource.live) stream.resource.observe("callback", "closed", true);
        })();
        // A self-close has no joining caller yet. Keep a failed release observable on the same promise.
        void closing.catch(() => {});
      }
      const callback = callbacks.getStore();
      if (callback?.stream === stream && stream.pending.has(callback.pending)) return { kind: "requested" };
      await closing;
      return { kind: "closed" };
    },
  };
}
