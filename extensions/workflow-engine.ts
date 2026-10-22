import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { currentWorkspace } from "./board/workspace.ts";
import { executionForSession } from "./execution-identity.ts";
import { openExecutionPlan, verifyExecutionBinding, updateLedgerTeamHold, writeExecutionUserDecision, ledgerFile, readExecutionBinding, type ExecutionBinding, type ExecutionPlan } from "./workflow.ts";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { AgentClosureError, hasUnknownClosure, joinedClosureObservation } from "./agent/closure.ts";
import { packageRoot } from "./stack.ts";
import { isChildSession } from "./profile.ts";
import { PlanSlot, snapshotPlan, registerPlanningTools, type PlanSnapshot, type PlanWriteReceipt } from "./workflow-planning.ts";
import { registerTaskTools, taskFreezeReceipt, type TaskAuthority } from "./workflow-task.ts";
import { receiptInBranch } from "./agent/delivery.ts";
import { deliveryContent } from "./agent/provenance.ts";
import {
  acquireWorkflowOwner, acquirePlanLock, WorkflowState, type Reservation, type ReservationSpec, type ResourceRef,
  type ResourceScope, type ReleaseReceipt, type RunFence, type RunRecord,
} from "./workflow-state.ts";

export type { ResourceRef, ResourceScope, RunFence, ReleaseReceipt } from "./workflow-state.ts";
export type CallContext = { kind: "ordinary"; guard: RootGuard } |
  { kind: "managed"; authority: PhaseAuthority } | { kind: "managed-unavailable"; reason: string };
export type PlanSource = { kind: "draft"; planId: string; revision: number | "absent"; file: string } |
  { kind: "frozen"; binding: ExecutionBinding };
export interface PhaseAuthority { readonly fence: Readonly<RunFence> }
export interface StatusReadAuthority { readonly runId: string }
export type ActivityRetirement = { kind: "requested" } | { kind: "closed" };
type HostOwner = {
  store: WorkflowState; run: RunRecord; binding?: ExecutionBinding; manager: object; active: boolean;
  planning?: PlanSlot; slotReservation?: OwnedReservation; slotProducer?: Producer;
  guard: RootGuard;
  observation: () => Producer;
  unlock: () => void; listeners: Set<() => void>; retire: Set<() => Promise<void>>;
};
type NativeSession = object & { getSessionId?: () => string };
type SessionBinding = {
  readonly manager: NativeSession;
  readonly sessionId: string | undefined;
  readonly context: CallContext;
};
type ReceiverScope = {
  manager: NativeSession; sessionId: string | undefined; initial: SessionBinding; owns: () => boolean;
  activity?: { owner: HostOwner; ownerId: string; epoch: number };
};
type CallScope = { kind: "operation"; context: CallContext } | { kind: "receiver"; receiver: ReceiverScope };
// Pi loads entries independently. Share captured host identities and their lifetime,
// not serialized permissions or a process-wide "current owner".
const HOST_KEY = Symbol.for("pitako.workflowHost");
function createHostState() {
  return {
    authorities: new WeakMap<PhaseAuthority, HostOwner>(),
    taskAuthorities: new WeakMap<TaskAuthority, HostOwner>(),
    readers: new WeakMap<StatusReadAuthority, HostOwner>(),
    activityObservers: new AsyncLocalStorage<{ owner: HostOwner; active: boolean }>(),
    guards: new WeakSet<RootGuard>(),
    contexts: new AsyncLocalStorage<CallScope | CallContext>(),
    sessions: new WeakMap<object, CallContext>(),
    sessionBindings: new WeakMap<object, SessionBinding>(),
    admissionOrigins: new WeakMap<CallContext, SessionBinding | undefined>(),
    liveProducers: new Map<string, Producer>(),
    // Only captured result custody can connect a disposition to its original transport.
    resultWaitSources: new WeakMap<PhaseAuthority, Map<string, (disposition: Extract<Disposition, { kind: "result-disposition" }>) => () => void>>(),
    ordinaryGuards: new Map<string, RootGuard>(),
    // JSON correlation can never nominate an ancestor lease.
    reservationParents: new WeakMap<CallContext, OwnedReservation>(),
    boundDrafts: new WeakMap<CallContext, PlanSnapshot>(),
    lateDefinitions: new Set<{ root: string; producer: Producer; observe: () => "closed" | "unknown" }>(),
    definitions: new WeakSet<object>(),
    definitionParameters: new WeakSet<object>(),
    readDefinitionParameters: new WeakSet<object>(),
  };
}
const host = globalThis as typeof globalThis & { [HOST_KEY]?: ReturnType<typeof createHostState> };
const state = host[HOST_KEY] ??= createHostState();
// Add metadata to the existing host on reload; never replace its live stores or guards.
state.sessionBindings ??= new WeakMap();
state.admissionOrigins ??= new WeakMap();
const { authorities, taskAuthorities, readers, activityObservers, guards, contexts, sessions, sessionBindings, admissionOrigins, liveProducers,
  resultWaitSources, ordinaryGuards, reservationParents, boundDrafts, lateDefinitions,
  definitions, definitionParameters, readDefinitionParameters } = state;
function reobserveDefinitions(root: string): void {
  for (const entry of lateDefinitions) {
    if (entry.root !== root) continue;
    try {
      if (entry.observe() !== "closed") continue;
      entry.producer.observe("callback", "closed");
      entry.producer.observe("host-operation", "closed", true);
      lateDefinitions.delete(entry);
    } catch { /* Retain the exact reservation if proof or persistence is unavailable. */ }
  }
}

export class RootGuard {
  readonly store: WorkflowState;
  readonly ownerId = randomUUID();
  constructor(root: string) {
    const physical = realpathSync(root);
    this.store = new WorkflowState(currentWorkspace(statSync(physical).isDirectory() ? physical : path.dirname(physical)));
    guards.add(this);
  }
  reserve(spec: ReservationSpec, authority?: PhaseAuthority): OwnedReservation {
    if (!guards.has(this)) throw new Error("unregistered root guard");
    reobserveDefinitions(this.store.root);
    const owner = authority && checkAuthority(authority);
    if (owner && owner.store.root !== this.store.root) throw new Error("authority root mismatch");
    if (owner && !["active", "waiting"].includes(owner.run.state)) throw new Error(`workflow activity is ${owner.run.state}`);
    const reservation = this.store.reserve(spec, owner?.run.ownerId ?? this.ownerId, authority?.fence);
    return new OwnedReservation(this.store, reservation, () => {
      if (!guards.has(this)) throw new Error("root guard retired");
      if (authority) checkAuthority(authority);
    });
  }
  assertIdle(paths: readonly string[], exclusiveOnly = false): void {
    reobserveDefinitions(this.store.root);
    const context = currentCallContext();
    const parent = context && (reservationParents.get(context) ??
      (context.kind === "managed" ? checkAuthority(context.authority).slotReservation : undefined));
    const ancestors = parent?.store.root === this.store.root
      ? this.store.ancestors(parent.reservation.reservationId) : new Set<string>();
    for (const reservation of this.store.all<Reservation>("reservations").sort((a, b) =>
      Number(b.state === "unknown") - Number(a.state === "unknown"))) {
      if (reservation.state === "released" || exclusiveOnly && reservation.kind === "writer" && reservation.state !== "unknown") continue;
      if (reservation.state === "active" && ancestors.has(reservation.reservationId)) continue;
      if (reservation.purpose === "observation" && reservation.state === "active") continue;
      if (paths.some(a => reservation.paths.some(b => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)))) {
        if (reservation.state === "unknown")
          throw new AgentClosureError([new Error(reservation.reason ?? "unreleased operation lease")], `operation lease ${reservation.reservationId}`);
        throw new Error(`active operation lease (${reservation.kind} lease) is occupied: ${reservation.reservationId}`);
      }
    }
  }
  close(): void { this.store.close(); guards.delete(this); }
}

function bindingCurrent(binding: SessionBinding): boolean {
  return sessionBindings.get(binding.manager) === binding && sessions.get(binding.manager) === binding.context &&
    binding.sessionId === binding.manager.getSessionId?.();
}
function assertOriginCurrent(origin: SessionBinding | undefined): void {
  if (origin && !bindingCurrent(origin)) throw new Error("original native admission retired or replaced");
}
function receiverBinding(receiver: ReceiverScope): SessionBinding {
  if (!receiver.owns() || receiver.manager.getSessionId?.() !== receiver.sessionId)
    throw new Error("native receiver owner retired");
  const binding = sessionBindings.get(receiver.manager);
  if (!binding || !bindingCurrent(binding)) throw new Error("native receiver binding unavailable");
  if (binding !== receiver.initial) {
    const activity = receiver.activity;
    if (!activity || binding.context.kind !== "managed") throw new Error("native receiver binding replaced");
    const owner = checkAuthority(binding.context.authority);
    if (owner !== activity.owner || owner.manager !== receiver.manager ||
        owner.run.ownerId !== activity.ownerId || owner.run.epoch !== activity.epoch)
      throw new Error("native receiver activity replaced");
  }
  checkCallContext(binding.context);
  return binding;
}
export function currentCallContext(session?: NativeSession): CallContext | undefined {
  const scope = contexts.getStore();
  if (scope?.kind === "receiver") {
    if (session && session !== scope.receiver.manager) throw new Error("foreign native receiver manager");
    return receiverBinding(scope.receiver).context;
  }
  const captured = scope?.kind === "operation" ? scope.context : scope;
  if (captured) {
    if (session) {
      const bound = sessions.get(session);
      const origin = admissionOrigins.get(captured);
      if (origin || bound) {
        if (captured.kind === "managed") checkAuthority(captured.authority);
        assertOriginCurrent(origin);
        if (bound !== captured) throw new Error("operation belongs to another native admission");
        const binding = sessionBindings.get(session);
        if (!binding || !bindingCurrent(binding)) throw new Error("native operation binding unavailable");
      } else if (captured.kind !== "ordinary" || executionForSession(session.getSessionId?.())?.managed) {
        throw new Error("native authority context is unavailable");
      }
    }
    return captured;
  }
  const bound = session && sessions.get(session);
  if (bound) return bound;
  if (session && executionForSession(session.getSessionId?.())?.managed)
    return { kind: "managed-unavailable", reason: "native authority context is unavailable" };
  return undefined;
}
export function captureCallContext(root: string | undefined, session?: object & { getSessionId?: () => string }): CallContext {
  const captured = currentCallContext(session);
  if (captured && (captured.kind !== "ordinary" || root === undefined)) return captured;
  if (captured) checkCallContext(captured);
  if (root === undefined) throw new Error("call context requires a captured root");
  const physical = realpathSync(root);
  const workspace = currentWorkspace(statSync(physical).isDirectory() ? physical : path.dirname(physical));
  if (captured?.guard.store.root === workspace) return captured;
  if (captured && admissionOrigins.get(captured)) throw new Error("native operation root mismatch");
  const guard = ordinaryGuards.get(workspace) ?? new RootGuard(workspace);
  ordinaryGuards.set(workspace, guard);
  const context: CallContext = { kind: "ordinary", guard };
  admissionOrigins.set(context, undefined);
  return context;
}
/** Registry entries are host objects, never reconstructed from names or execution correlation. */
export function bindCallContext(session: object, context: CallContext): () => void {
  const prior = sessions.get(session);
  if (prior?.kind === "managed" && authorities.get(prior.authority)?.active) throw new Error("native context already bound");
  const manager: NativeSession = session;
  const binding: SessionBinding = { manager, sessionId: manager.getSessionId?.(), context };
  sessions.set(session, context);
  sessionBindings.set(session, binding);
  // SDK children bind their attempt context, but cannot replace its original provenance.
  if (!admissionOrigins.has(context)) admissionOrigins.set(context, binding);
  return () => { if (sessionBindings.get(session) === binding && sessions.get(session) === context) sessions.set(session, {
    kind: "managed-unavailable", reason: "captured native context retired",
  }); };
}
/** Only real foreground lifecycle admission may publish an ordinary native root. */
export function bindForegroundCallContext(root: string, manager: NativeSession): () => void {
  const prior = sessions.get(manager), binding = sessionBindings.get(manager);
  if (prior && (!binding || binding.sessionId === manager.getSessionId?.())) {
    if (prior.kind === "ordinary") throw new Error("native foreground already bound");
    // A trusted lifecycle can replace its closed ordinary admission, never a
    // managed binding or its tombstone. Old operation origins stay retired.
    if (prior.kind !== "managed-unavailable" || binding?.context.kind !== "ordinary") return () => {};
  }
  const physical = realpathSync(root), workspace = currentWorkspace(physical);
  const guard = ordinaryGuards.get(workspace) ?? new RootGuard(workspace);
  ordinaryGuards.set(workspace, guard);
  return bindCallContext(manager, { kind: "ordinary", guard });
}
/** Host-only effect boundary. Producer scopes never become receiver authority. */
export function withReceiverContext<T>(manager: NativeSession, expected: CallContext, owns: () => boolean, operation: () => T): T {
  const binding = sessionBindings.get(manager);
  if (!binding || binding.context !== expected || !bindingCurrent(binding) || reservationParents.has(expected))
    throw new Error("native receiver requires the current principal root binding");
  const receiver: ReceiverScope = { manager, sessionId: manager.getSessionId?.(), initial: binding, owns };
  if (expected.kind === "managed") {
    const owner = checkAuthority(expected.authority);
    if (owner.manager !== manager) throw new Error("foreign native receiver owner");
    receiver.activity = { owner, ownerId: owner.run.ownerId, epoch: owner.run.epoch };
  }
  receiverBinding(receiver);
  return contexts.run({ kind: "receiver", receiver }, operation);
}
export function withCallContext<T>(context: CallContext, operation: () => T): T {
  if (!admissionOrigins.has(context)) admissionOrigins.set(context, undefined);
  return contexts.run({ kind: "operation", context }, operation);
}
export function checkCallContext(context: CallContext): RootGuard {
  if (context.kind === "managed-unavailable") throw new Error(context.reason);
  if (context.kind === "managed") {
    const guard = checkAuthority(context.authority).guard;
    assertOriginCurrent(admissionOrigins.get(context));
    return guard;
  }
  assertOriginCurrent(admissionOrigins.get(context));
  if (!guards.has(context.guard)) throw new Error("ordinary root guard retired");
  return context.guard;
}
export function reserveEffect(context: CallContext, spec: ReservationSpec): OwnedReservation {
  const parent = reservationParents.get(context) ??
    (context.kind === "managed" ? checkAuthority(context.authority).slotReservation : undefined);
  return checkCallContext(context).reserve({ ...spec,
    ...(parent && !spec.parentReservationId ? { parentReservationId: parent.reservation.reservationId } : {}) },
  context.kind === "managed" ? context.authority : undefined);
}

export type AttemptWatch = { planId: string; unitId: string; execution?: ExecutionBinding; unavailable?: string };
export type AttemptRecord = {
  instanceId: string; dispatchId: string; roleId: string; assignmentId: string;
  reservationId: string; resource: ResourceRef; watch?: AttemptWatch;
  outcome?: { status: "completed" | "failed" | "cancelled"; result: string };
};
export type TeamHoldRecord = {
  assignmentId: string; planId: string; unitId: string; execution?: ExecutionBinding;
  reservationId?: string; status: "pending" | "failed" | "cancelled"; cleared: boolean;
  recoveryId?: string;
};
export type RecoveryClaim = {
  assignmentId: string; dispatchId: string; receipt: ReleaseReceipt;
  evidence: { dispatchId: string; outcomeHash: string }[];
  repository: string; remainingResult: string;
};
export type RecoveryReceipt = RecoveryClaim & {
  recoveryId: string; runId: string; planId: string; unitId: string;
  outcome: AttemptRecord["outcome"] | null;
};
export const outcomeHash = (outcome: NonNullable<AttemptRecord["outcome"]>): string =>
  createHash("sha256").update(JSON.stringify(outcome)).digest("hex");
const holdKey = (planId: string, assignmentId: string) => JSON.stringify([planId, assignmentId]);
function putHold(store: WorkflowState, hold: TeamHoldRecord): void {
  const key = holdKey(hold.planId, hold.assignmentId);
  const previous = store.get<TeamHoldRecord>("holds", key);
  if (previous && (previous.unitId !== hold.unitId || JSON.stringify(previous.execution) !== JSON.stringify(hold.execution) ||
      previous.reservationId !== hold.reservationId)) throw new Error("Team hold belongs to another captured assignment");
  store.put("holds", key, hold);
  store.enqueue(`team-holds:${hold.planId}`, JSON.stringify(hold.execution ?? { kind: "draft", planId: hold.planId }),
    { kind: "team-hold", hold });
}
/** Projection is an ordered sink. It never becomes the source of hold authority. */
export function projectTeamHolds(store: WorkflowState): void {
  const targets = new Set(store.outbox().filter(entry => entry.target.startsWith("team-holds:") &&
    !["applied", "not-applicable"].includes(entry.state)).map(entry => entry.target));
  const failures: unknown[] = [];
  for (const target of targets) {
    let release: () => void;
    try { release = acquirePlanLock(store.root, target.slice("team-holds:".length), "team-holds-projection"); }
    catch (error) { failures.push(error); continue; } // Leave this target intact; other plans may progress.
    try {
      // Read the ordered outbox again under target exclusion. A stale drainer
      // must not replay an earlier hold after another drainer has cleared it.
      store.project(entry => {
        const body = entry.body as { kind?: string; hold?: TeamHoldRecord };
        if (body.kind !== "team-hold") return "blocked";
        const hold = body.hold!;
        if (!hold.execution) return "not-applicable"; // A draft has no execution ledger.
        const plan = verifyExecutionBinding(hold.execution);
        const applied = updateLedgerTeamHold(hold.execution.executionRoot, hold.planId,
          { assignmentId: hold.assignmentId, unitId: hold.unitId, status: hold.status }, hold.cleared, hold.execution);
        if (applied) return "applied";
        return plan.meta.boardTopicId === undefined ? "not-applicable" : "blocked";
      }, entry => entry.target === target);
    } finally { release(); }
  }
  if (failures.length) throw new AggregateError(failures, "Team hold projection target unavailable");
}
function checkTeamProjection(store: WorkflowState, planId: string): void {
  const pending = store.outbox().find(entry => entry.target === `team-holds:${planId}` &&
    !["applied", "not-applicable"].includes(entry.state));
  if (pending) throw new Error(`Team hold projection is blocked: ${
    (pending.body as { projectionDiagnostic?: string }).projectionDiagnostic ?? pending.state}`);
}
/** Commit attempt, resource and hold together, before publishing a Row or scheduling preparation. */
export function registerBackgroundAttempt(context: CallContext, input: {
  cwd: string; instanceId: string; dispatchId: string; roleId: string; assignmentId?: string; watch?: AttemptWatch; archive?: boolean;
}) {
  const guard = checkCallContext(context), store = guard.store;
  if (!admissionOrigins.has(context)) admissionOrigins.set(context, undefined);
  const origin = admissionOrigins.get(context);
  const assertAdmissionCurrent = () => { assertOriginCurrent(origin); checkCallContext(context); };
  const cwd = realpathSync(input.cwd);
  if (cwd !== store.root && currentWorkspace(cwd) !== store.root) throw new Error("attempt context/root mismatch");
  if (input.watch?.execution) {
    verifyExecutionBinding(input.watch.execution);
    if (input.watch.execution.executionRoot !== store.root) throw new Error("attempt binding/root mismatch");
  }
  const assignmentId = input.assignmentId ?? input.dispatchId;
  let producer!: Producer;
  let archive: Producer | undefined;
  let attempt!: AttemptRecord;
  let captured = context;
  store.transaction(() => {
    const reservation = reserveEffect(context, { reservationId: randomUUID(), kind: "writer", paths: [store.root] });
    producer = reservation.register("background-attempt", ["preparation", "host-operation", "callback"]);
    if (input.archive) archive = reservation.register("table-archive", ["host-operation", "callback"]);
    attempt = { ...input, assignmentId, reservationId: reservation.reservation.reservationId, resource: producer.ref };
    if (store.get("attempts", input.dispatchId)) throw new Error("attempt already registered");
    store.put("attempts", input.dispatchId, attempt);
    if (input.watch) putHold(store, { ...input.watch, assignmentId, reservationId: attempt.reservationId,
      status: "pending", cleared: false });
    store.enqueue(`attempt:${input.dispatchId}`, JSON.stringify(producer.ref), { kind: "registered", attempt });
    captured = { ...context };
    admissionOrigins.set(captured, origin);
    reservationParents.set(captured, reservation);
    if (context.kind === "managed") {
      const owner = checkAuthority(context.authority);
      const draft = boundDrafts.get(context) ?? owner.planning?.read();
      if (draft) boundDrafts.set(captured, draft);
    }
  });
  return {
    context: captured, producer, archive, attempt, store,
    assertAdmissionCurrent,
    receiverContext(manager: object): CallContext {
      assertAdmissionCurrent();
      if (!origin || origin.manager !== manager || reservationParents.has(origin.context))
        throw new Error("result has no original native principal receiver");
      return origin.context;
    },
    receipt: () => store.all<ReleaseReceipt>("receipts").find(receipt =>
      receipt.reservationId === attempt.reservationId && store.verifyReceipt(receipt)),
    admit() {
      checkCallContext(context);
      producer.enter();
      archive?.enter();
    },
    checkProjection() {
      checkCallContext(context);
      if (input.watch?.execution) openExecutionPlan(input.watch.planId, store.root,
        { createLedger: true, source: verifyExecutionBinding(input.watch.execution) });
      projectTeamHolds(store);
      if (input.watch) checkTeamProjection(store, input.watch.planId);
    },
    result(outcome: NonNullable<AttemptRecord["outcome"]>) {
      // Append to the original attempt even after foreground authority has retired.
      store.transaction(() => {
        const saved = store.get<AttemptRecord>("attempts", input.dispatchId);
        if (!saved || JSON.stringify(saved.resource) !== JSON.stringify(producer.ref)) throw new Error("foreign attempt result");
        if (saved.outcome && JSON.stringify(saved.outcome) !== JSON.stringify(outcome)) throw new Error("attempt result already recorded");
        if (saved.outcome) return;
        saved.outcome = outcome;
        store.put("attempts", input.dispatchId, saved);
        store.enqueue(`attempt:${input.dispatchId}`, JSON.stringify(producer.ref), { kind: "result", outcome });
        if (input.watch && outcome.status !== "completed") putHold(store, { ...input.watch, assignmentId,
          reservationId: attempt.reservationId, status: outcome.status, cleared: false });
        const obligationId = `result:${input.dispatchId}`;
        store.put("obligations", obligationId, { obligationId, kind: "result", dispatchId: input.dispatchId,
          runId: context.kind === "managed" ? context.authority.fence.runId : null, cleared: false });
      });
    },
  };
}
export type BackgroundAttempt = ReturnType<typeof registerBackgroundAttempt>;

export type ResultObligation = {
  obligationId: string; kind: "result"; dispatchId: string; resultId: string; unitId: string;
  runId: string | null; fence?: Readonly<RunFence>; cleared: boolean;
  version: number; state: "pending-receipt" | "receipt" | "disposition-required";
  receipt?: { deliveryId: string; entryId?: string };
  boundary?: "context" | "turn_start";
  message: { customType: string; content: string; details: { deliveryId: string } };
};
type DispositionRequest = {
  kind: "wake-issued" | "no-progress"; state: "wake-issued" | "no-progress";
  runId: string | null; resultId: string; cause: string; transition: "result-ready" | "producer-settled";
  obligationVersion: number;
  obligationId: string; unitId: string; fence: Readonly<RunFence> | null; envelope: string; credit: 0 | 1;
};
/** Original admission and producer facts travel with the result, never with a replacement owner. */
export interface CapturedWakeSource {
  readonly resultId: string;
  observe(boundary?: "context" | "turn_start" | "agent_settled"): void;
  claimWake(envelope: string): boolean;
  assertIssued(): void;
  receiverContext(manager: object): CallContext;
  recoveryPending(): boolean;
  noProgress(): boolean;
}
export function captureResultSource(attempt: BackgroundAttempt, resultId: string,
  message: { customType: string; content: string; details: { deliveryId: string } },
  owner: { owns: () => boolean; getBranch: () => readonly unknown[]; waitReady?: (source: CapturedWakeSource) => void }): CapturedWakeSource {
  const { context, store } = attempt;
  const runId = context.kind === "managed" ? context.authority.fence.runId : null;
  const obligationId = `result:${resultId}`;
  // Run/result/cause-transition, deliberately independent of request, carrier and phase epoch.
  const cause = `wake:${runId ?? attempt.attempt.resource.producerId}:${resultId}:result-ready`;
  const check = () => { attempt.assertAdmissionCurrent(); if (!owner.owns()) throw new Error("original result owner retired"); };
  let effectiveReceipt: unknown;
  const exactReceipt = () => {
    const branch = owner.getBranch();
    check();
    return branch.find(entry => receiptInBranch(message, [entry]));
  };
  store.transaction(() => {
    check();
    const previous = store.get<ResultObligation>("obligations", obligationId);
    if (previous?.resultId) throw new Error("result source already registered");
    store.put("obligations", obligationId, { obligationId, kind: "result", dispatchId: attempt.attempt.dispatchId, resultId,
      unitId: attempt.attempt.watch?.unitId ?? attempt.attempt.instanceId, runId,
      ...(context.kind === "managed" ? { fence: context.authority.fence } : {}),
      message: structuredClone(message), cleared: false, version: 1, state: "pending-receipt" } satisfies ResultObligation);
  });
  if (context.kind === "managed" && owner.waitReady) {
    let sources = resultWaitSources.get(context.authority);
    if (!sources) resultWaitSources.set(context.authority, sources = new Map());
    sources.set(obligationId, disposition => {
      check();
      const receipt = exactReceipt();
      if (!receipt || receipt !== effectiveReceipt) throw new Error("wait requires the original effective receipt");
      const ref = disposition.choice.kind === "wait" && disposition.choice.producerRef;
      if (!ref) throw new Error("wait requires a producer");
      const reference = JSON.stringify([ref.resourceId, ref.producerId, ref.reservationId, ref.generation]);
      const version = disposition.expectedVersion;
      const valid = () => {
        check();
        if (exactReceipt() !== receipt) throw new Error("wait receipt left the original branch");
        const latest = store.all<Disposition & { runId?: string }>("dispositions").filter(item =>
          item.kind === "result-disposition" && item.runId === runId && item.obligationId === obligationId).at(-1);
        if (latest?.kind !== "result-disposition" || latest.expectedVersion !== version ||
            latest.choice.kind !== "wait" || !sameResource(latest.choice.producerRef, ref))
          throw new Error("wait disposition was superseded");
      };
      // A real producer settlement is a distinct transition. Its identity never
      // includes a carrier, request id or phase, and cannot replenish result-ready.
      const source = wakeSource(`wake:${runId}:${resultId}:producer-settled:${reference}`, "producer-settled", valid);
      return () => { valid(); owner.waitReady!(source); };
    });
  }
  return wakeSource(cause, "result-ready");

  function wakeSource(cause: string, transition: DispositionRequest["transition"], valid = check): CapturedWakeSource {
    let creditedReceipt: unknown;
    let issued = false;
    let recoveryExhausted = false;
    return Object.freeze({
      resultId,
      receiverContext(manager: object) { valid(); return attempt.receiverContext(manager); },
      observe(boundary?: "context" | "turn_start" | "agent_settled") {
        valid();
        const receipt = exactReceipt();
        if (boundary === "context" || boundary === "turn_start")
          creditedReceipt = issued ? receipt : undefined;
        store.transaction(() => {
          check();
          const saved = store.get<ResultObligation>("obligations", obligationId)!;
          const next = { ...saved };
          if (!receipt || receipt !== effectiveReceipt) {
            delete next.boundary;
            next.state = receipt ? "receipt" : "pending-receipt";
            effectiveReceipt = undefined;
          }
          if (receipt) {
            next.receipt = { deliveryId: message.details.deliveryId,
              ...(typeof receipt === "object" && receipt && "id" in receipt && typeof receipt.id === "string" ? { entryId: receipt.id } : {}) };
            if (next.state === "pending-receipt") next.state = "receipt";
            if (boundary === "context" || boundary === "turn_start") {
              effectiveReceipt = receipt;
              next.state = "disposition-required"; next.boundary = boundary;
            }
          }
          if (JSON.stringify(next) !== JSON.stringify(saved)) {
            next.version++;
            store.put("obligations", obligationId, next);
            store.enqueue(`obligation:${obligationId}`, JSON.stringify(attempt.attempt.resource), next);
          }
          // Visibility enables a claim in this turn; only its terminal boundary can
          // diagnose an undisposed credited continuation. Neither fact is acceptance.
          if (boundary === "agent_settled" && issued && receipt && creditedReceipt === receipt) {
            const request = store.get<DispositionRequest>("dispositions", cause);
            const disposed = store.all<Disposition & { runId?: string }>("dispositions").some(item =>
              item.kind === "result-disposition" && item.runId === runId && item.obligationId === obligationId &&
              item.expectedVersion >= (request?.obligationVersion ?? 0));
            if (request && !disposed && !store.get("dispositions", `${cause}:no-progress`)) {
              const stalled = { ...request, kind: "no-progress", state: "no-progress" } satisfies DispositionRequest;
              store.put("dispositions", `${cause}:no-progress`, stalled);
              store.enqueue(`disposition:${cause}`, JSON.stringify(attempt.attempt.resource), stalled);
            }
          }
        });
      },
      claimWake(envelope: string) {
        valid();
        return store.transaction(() => {
          valid();
          const previous = store.get<DispositionRequest>("dispositions", cause);
          if (previous) { recoveryExhausted = true; return false; }
          const obligation = store.get<ResultObligation>("obligations", obligationId)!;
          store.put("dispositions", cause, { kind: "wake-issued", resultId, runId, cause, obligationId,
            transition, obligationVersion: obligation.version, state: "wake-issued", unitId: obligation.unitId,
            fence: context.kind === "managed" ? context.authority.fence : null, envelope, credit: 0 } satisfies DispositionRequest);
          issued = true;
          return true;
        });
      },
      assertIssued() {
        valid();
        if (!issued || store.get<{ kind: string }>("dispositions", cause)?.kind !== "wake-issued")
          throw new Error("result wake has no committed causal credit");
      },
      recoveryPending: () => !recoveryExhausted && !store.get("dispositions", `${cause}:no-progress`),
      noProgress: () => !!store.get("dispositions", `${cause}:no-progress`),
    });
  }
}
/** Only the matching committed receipt and successful recorded outcome can clear a normal hold. */
export function reconcileTeamHold(store: WorkflowState, watch: AttemptWatch, assignmentId: string,
  status: "pending" | "completed" | "failed" | "cancelled" | undefined, receipt?: ReleaseReceipt): void {
  store.transaction(() => {
    const key = holdKey(watch.planId, assignmentId);
    const hold = store.get<TeamHoldRecord>("holds", key);
    if (!hold) {
      putHold(store, { ...watch, assignmentId, status: status === "failed" || status === "cancelled" ? status : "pending", cleared: false });
      if (status === "completed") throw new Error("Team hold has no registered attempt");
      return;
    }
    if (hold.unitId !== watch.unitId || JSON.stringify(hold.execution) !== JSON.stringify(watch.execution))
      throw new Error("Team hold binding mismatch");
    if (status === "completed") {
      const attempt = store.all<AttemptRecord>("attempts").find(value => value.assignmentId === assignmentId &&
        value.reservationId === hold.reservationId && value.watch?.planId === watch.planId);
      if (attempt?.outcome?.status !== "completed") throw new Error("Team hold has no matching successful outcome");
      // Result bookkeeping can precede physical closure. It is not hold recovery.
      // The original producer will append the exact committed receipt after closure.
      if (receipt) {
        if (receipt.reservationId !== hold.reservationId || !store.verifyReceipt(receipt))
          throw new Error("Team hold requires its exact release receipt");
        hold.cleared = true;
      }
    } else {
      // Failed, cancelled and preflight-without-outcome require explicit recovery, not delivery.
      hold.status = status === "failed" || status === "cancelled" ? status : "pending";
    }
    putHold(store, hold);
  });
  projectTeamHolds(store);
  checkTeamProjection(store, watch.planId);
}

/** Explicit host recovery is distinct from resource release and successful completion.
 * Authority comes only from the captured live foreground grant, never the documentation.
 */
export function recoverHold(authority: PhaseAuthority, claim: RecoveryClaim): RecoveryReceipt {
  const owner = checkAuthority(authority), store = owner.store;
  const binding = owner.binding;
  if (!binding) throw new Error("execution hold recovery requires an execution activity");
  const recovered = store.transaction(() => {
    checkAuthority(authority);
    if (claim.repository !== store.root || !claim.remainingResult.trim() || !claim.evidence.length)
      throw new Error("recovery requires captured repository, evidence and remaining result");
    const attempt = store.get<AttemptRecord>("attempts", claim.dispatchId);
    if (!attempt || attempt.assignmentId !== claim.assignmentId || !attempt.watch?.execution ||
        JSON.stringify(attempt.watch.execution) !== JSON.stringify(owner.binding))
      throw new Error("recovery attempt belongs to another assignment or binding");
    const hold = store.get<TeamHoldRecord>("holds", holdKey(binding.planId, claim.assignmentId));
    if (!hold || hold.cleared || hold.reservationId !== attempt.reservationId || hold.unitId !== attempt.watch.unitId)
      throw new Error("recovery has no matching outstanding hold");
    if (claim.receipt.reservationId !== attempt.reservationId || !store.verifyReceipt(claim.receipt))
      throw new Error("recovery requires the exact committed resource release receipt");
    for (const evidence of claim.evidence) {
      const source = store.get<AttemptRecord>("attempts", evidence.dispatchId);
      if (!source?.outcome || JSON.stringify(source.watch?.execution) !== JSON.stringify(owner.binding) ||
          outcomeHash(source.outcome) !== evidence.outcomeHash) throw new Error("recovery evidence is missing, foreign or stale");
    }
    const receipt: RecoveryReceipt = { ...structuredClone(claim), recoveryId: randomUUID(), runId: owner.run.runId,
      planId: binding.planId, unitId: hold.unitId, outcome: attempt.outcome ?? null };
    store.put("recoveries", receipt.recoveryId, receipt);
    putHold(store, { ...hold, cleared: true, recoveryId: receipt.recoveryId });
    return receipt;
  });
  if (JSON.stringify(store.get("recoveries", recovered.recoveryId)) !== JSON.stringify(recovered))
    throw new Error("recovery receipt was not committed");
  projectTeamHolds(store);
  checkTeamProjection(store, binding.planId);
  return recovered;
}

/** Captures the actual host definition, not permission attached to a tool-name string. */
export function guardDefinition<P extends TSchema, D, S>(definition: ToolDefinition<P, D, S>,
  effect: "read" | "write", preserveSchema = false,
  unavailable?: (error: unknown) => Awaited<ReturnType<typeof definition.execute>>): ToolDefinition<P, D, S> {
  const execute = definition.execute.bind(definition);
  const wrapped = { ...definition, parameters: preserveSchema ? definition.parameters : { ...definition.parameters },
    execute(...args: Parameters<typeof definition.execute>) {
    const [id, params, signal, update, ctx] = args;
    if (effect === "read") {
      // Observation validates any captured owner, but does not acquire workspace
      // state: archived native history may outlive its physical checkout.
      let context: CallContext | undefined;
      try {
        context = currentCallContext(ctx.sessionManager);
        if (context) checkCallContext(context);
      }
      catch (error) {
        if (unavailable) return Promise.resolve(unavailable(error));
        throw error;
      }
      return context ? withCallContext(context, () => execute(...args)) : execute(...args);
    }
    let context: CallContext, guard: RootGuard;
    try {
      context = captureCallContext(ctx.cwd, ctx.sessionManager);
      guard = checkCallContext(context);
    } catch (error) {
      if (unavailable) return Promise.resolve(unavailable(error));
      throw error;
    }
    assertGenericWrite(context);
    return (async () => {
    const resource = reserveEffect(context, { reservationId: randomUUID(), kind: "writer", paths: [realpathSync(ctx.cwd)] })
      .register(`definition:${definition.name}`, ["host-operation", "callback"], "work", "host-return-dependent");
    resource.enter();
    const pending = new Set<Promise<unknown>>(), failures: unknown[] = [];
    let value: Awaited<ReturnType<typeof definition.execute>> | undefined;
    try {
      value = await withCallContext(context, () => execute(id, params, signal, update ? value => {
        try {
          const callback = Promise.resolve(withCallContext(context, () => update(value)));
          pending.add(callback);
          void callback.then(() => pending.delete(callback), error => { failures.push(error); pending.delete(callback); });
        } catch (error) { failures.push(error); }
      } : undefined, ctx));
    } catch (error) { failures.push(error); }
    while (pending.size) await Promise.allSettled([...pending]);
    const unknown = failures.some(hasUnknownClosure);
    resource.observe("callback", unknown ? "unknown" : "closed");
    resource.observe("host-operation", unknown ? "unknown" : "closed", true);
    if (unknown) {
      const observation = joinedClosureObservation(failures);
      if (observation) lateDefinitions.add({ root: guard.store.root,
        producer: resource, observe: () => observation.observe() });
      throw new AgentClosureError(failures, `definition:${definition.name}`, observation);
    }
    if (failures.length) throw new AggregateError(failures, `definition:${definition.name}`);
    return value!;
    })();
  } };
  definitions.add(wrapped);
  definitionParameters.add(wrapped.parameters);
  if (effect === "read") readDefinitionParameters.add(wrapped.parameters);
  return wrapped;
}
export function isGuardedDefinition(definition: object): boolean { return definitions.has(definition); }
export function hasDefinitionGuard(parameters: object): boolean { return definitionParameters.has(parameters); }
export function hasReadDefinitionGuard(parameters: object): boolean { return readDefinitionParameters.has(parameters); }
export function guardToolRegistrations(pi: ExtensionAPI, effect: "read" | "write"): ExtensionAPI {
  return { ...pi, registerTool(definition) { pi.registerTool(guardDefinition(definition, effect)); } };
}

export class OwnedReservation {
  constructor(readonly store: WorkflowState, readonly reservation: Reservation, private admit: () => void) {}
  register(adapter: string, scopes: ResourceScope[], purpose: "work" | "observation" = this.reservation.purpose ?? "work",
    dependency: "independent" | "host-return-dependent" = "independent"): Producer {
    this.admit();
    const resource = this.store.resource(this.reservation, { adapter, scopes, purpose });
    const producer = new Producer(this.store, resource, this.admit, dependency);
    liveProducers.set(resource.resourceId, producer);
    return producer;
  }
}

/** No serialized reference can acquire this append port. It has no admission capability. */
export class Producer {
  readonly ref: ResourceRef;
  private sequence = 0;
  private listeners = new Set<() => void>();
  private ended = false;
  constructor(private store: WorkflowState, resource: ResourceRef, private admit: () => void,
    readonly dependency: "independent" | "host-return-dependent" = "independent") {
    const { resourceId, producerId, reservationId, generation } = resource;
    this.ref = Object.freeze({ resourceId, producerId, reservationId, generation });
  }
  enter(): void { this.admit(); this.store.enter(this.ref); }
  observe(scope: ResourceScope, fact: "closed" | "unknown", seal = false): ReleaseReceipt | undefined {
    const receipt = this.store.observe(this.ref, ++this.sequence, scope, fact, seal);
    if (receipt && !this.store.verifyReceipt(receipt)) throw new Error("release receipt was not committed");
    if (receipt) { this.ended = true; liveProducers.delete(this.ref.resourceId); }
    for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot change reduction. */ } }
    return receipt;
  }
  get live(): boolean { return !this.ended && liveProducers.get(this.ref.resourceId) === this; }
  get cursor(): number { return this.sequence; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot() { return this.store.exactResource(this.ref); }
}

export function checkAuthority(authority: PhaseAuthority): HostOwner {
  const owner = authorities.get(authority);
  if (!owner?.active) throw new Error("unavailable or retired workflow authority");
  if (owner.run.activity === "plan" && owner.run.state === "completed") {
    // Completed planning retains only exact receipt/Board lifecycle reads.
    // Admission still requires WorkflowState.fence, which rejects terminal runs.
    if (JSON.stringify(owner.store.get("runs", owner.run.runId)) !== JSON.stringify(owner.run))
      throw new Error("completed planning source is stale");
  } else owner.store.fence(authority.fence);
  if (owner.binding) verifyExecutionBinding(owner.binding);
  else owner.planning?.read();
  return owner;
}
export function planningSlot(authority: PhaseAuthority): PlanSlot {
  const owner = checkAuthority(authority);
  if (owner.run.phase !== "planning" || !owner.planning) throw new Error("no live planning slot");
  return owner.planning;
}
export function readBoundPlan(context: CallContext) {
  if (context.kind !== "managed") throw new Error("no captured bound-plan source");
  const owner = checkAuthority(context.authority);
  if (!owner.planning) return verifyExecutionBinding(owner.binding!);
  const current = owner.planning.read(), captured = boundDrafts.get(context);
  if (captured && (captured.objectHash !== current.objectHash || captured.revision !== current.revision))
    throw new Error("captured draft changed");
  return captured ?? current;
}
export function assertPlanningQuiescent(authority: PhaseAuthority): void {
  const owner = checkAuthority(authority);
  const pending = owner.store.all<Reservation>("reservations").filter(item => item.runId === owner.run.runId &&
    item.reservationId !== owner.slotReservation?.reservation.reservationId && item.state !== "released" && item.purpose !== "observation");
  if (pending.length) throw new Error("planning resources remain active or unknown");
}
export function assertGenericWrite(context: CallContext): void {
  if (context.kind === "managed" && checkAuthority(context.authority).run.phase === "planning")
    throw new Error("managed planning uses the host slot writer; generic mutations are unavailable");
  checkCallContext(context);
}
/** Track the accepted observer frontier across await, without granting write authority. */
export async function runActivityObserver(read: StatusReadAuthority, receive: () => Promise<void>): Promise<void> {
  const callback = { owner: statusOwner(read), active: true };
  await activityObservers.run(callback, async () => {
    try { await receive(); }
    finally { callback.active = false; }
  });
}
export function openExecuteActivity(plan: ExecutionPlan, manager: object, sessionId: string) {
  verifyExecutionBinding(plan.binding);
  const activity = openActivity({ binding: plan.binding }, manager, sessionId);
  return { ...activity, readBoundPlan: () => { checkAuthority(activity.authority); return verifyExecutionBinding(plan.binding); } };
}
export function openPlanActivity(id: string, root: string, expected: PlanSnapshot, manager: object, sessionId: string) {
  return openActivity({ id, root, expected }, manager, sessionId);
}
export function checkTaskAuthority(authority: TaskAuthority): HostOwner {
  const owner = taskAuthorities.get(authority);
  if (!owner?.active || !owner.run.task || authority.intentId !== owner.run.task.intentId ||
      authority.epoch !== owner.run.epoch) throw new Error("task intent is retired or stale");
  owner.store.fence(owner.run);
  if (owner.binding) verifyExecutionBinding(owner.binding);
  return owner;
}
export function openTaskActivity(id: string, root: string, expected: PlanSnapshot, manager: object, sessionId: string) {
  const store = new WorkflowState(root);
  try {
    const previous = store.all<RunRecord>("runs").filter(run => run.activity === "task" && run.planId === id).at(-1);
    if (previous?.state === "completed") throw new Error("task is already completed");
    const receipt = previous && taskFreezeReceipt(store, previous);
    if (expected.meta?.status === "frozen" && !receipt) throw new Error("frozen status is not a registered task FreezeReceipt");
    if (previous && store.all<Reservation>("reservations").some(r => r.runId === previous.runId && r.state !== "released"))
      throw new Error("previous task resources remain active or unknown; exact recovery required");
    if (receipt && (receipt.newHash !== expected.fileHash || receipt.snapshot.text !== expected.text))
      throw new Error("task FreezeReceipt source changed");
    return openActivity(receipt
      ? { binding: openExecutionPlan(id, root, { createLedger: false }).binding }
      : { id, root, expected }, manager, sessionId, { previous, receipt });
  } finally { store.close(); }
}
function openActivity(source: { binding: ExecutionBinding } | { id: string; root: string; expected: PlanSnapshot }, manager: object, sessionId: string,
  task?: { previous?: RunRecord; receipt?: PlanWriteReceipt }) {
  const planning = !("binding" in source);
  const store = new WorkflowState("binding" in source ? source.binding.executionRoot : source.root);
  const planId = "binding" in source ? source.binding.planId : source.id;
  let unlock: (() => void) | undefined;
  let slotReservation: OwnedReservation | undefined;
  let unownedGuard: RootGuard | undefined;
  try {
    unlock = acquireWorkflowOwner(store.root, planId);
    const fence = { runId: task?.previous?.runId ?? randomUUID(), ownerId: randomUUID(), epoch: (task?.previous?.epoch ?? 0) + 1,
      phaseEpoch: task?.previous?.phaseEpoch ?? 1 };
    if (task?.previous?.phase === "planning" && !planning) fence.phaseEpoch++;
    const run: RunRecord = { ...fence, activity: task ? "task" : planning ? "plan" : "execute", phase: planning ? "planning" : "execution", planId,
      binding: JSON.stringify("binding" in source ? source.binding : source.expected), sessionId, state: "active", version: 1, selectedUnit: null,
      lastFactAt: new Date().toISOString(),
      ...(task ? { task: { ...task.previous?.task, intentId: task.previous?.task?.intentId ?? randomUUID(),
        ...(task.receipt ? { freezeReceiptRef: task.receipt.receiptId } : {}) }, version: (task.previous?.version ?? 0) + 1 } : {}) };
    store.transaction(() => { store.put("runs", run.runId, run); store.enqueue(`run:${run.runId}`, run.binding, { kind: "opened" }); });
    const guard = unownedGuard = new RootGuard(store.root);
    const owner: HostOwner = { store, guard, run, ...("binding" in source ? { binding: Object.freeze({ ...source.binding }) } : {}), manager, active: true, unlock,
      observation: () => {
        const admit = () => {
          if (!owner.active || !["active", "waiting"].includes(owner.run.state)) throw new Error("activity retired or terminal");
          store.fence(owner.run);
        };
        admit();
        const reservation = guard.store.reserve({ reservationId: randomUUID(), kind: "writer",
          paths: [store.root], purpose: "observation" }, owner.run.ownerId, owner.run);
        return new OwnedReservation(guard.store, reservation, admit).register("activity-status", ["callback"], "observation");
      },
      listeners: new Set(), retire: new Set() };
    const authority = Object.freeze({ fence: Object.freeze(fence) });
    const read = Object.freeze({ runId: run.runId });
    authorities.set(authority, owner); readers.set(read, owner);
    const taskAuthority: TaskAuthority | undefined = task && Object.freeze({ intentId: run.task!.intentId, epoch: run.epoch });
    if (taskAuthority) taskAuthorities.set(taskAuthority, owner);
    if (!("binding" in source)) {
      slotReservation = owner.slotReservation = guard.reserve({ reservationId: randomUUID(), kind: "assignment-writer", paths: [store.root] }, authority);
      owner.slotProducer = owner.slotReservation.register("planning-slot", ["host-operation"], "work", "host-return-dependent");
      owner.slotProducer.enter();
      owner.planning = new PlanSlot(source.id, store, source.expected, () => {
        if (!owner.active) throw new Error("planning owner retired");
        if (owner.run.state === "completed") {
          if (JSON.stringify(store.get("runs", owner.run.runId)) !== JSON.stringify(owner.run))
            throw new Error("completed planning source is stale");
        } else store.fence(authority.fence);
      }, () => {
        checkAuthority(authority);
        if (owner.run.state !== "active") throw new Error(`planning activity is ${owner.run.state}`);
      });
    }
    let retiring: Promise<void> | undefined;
    return {
      authority, read, context: { kind: "managed", authority } as const, guard,
      taskAuthority,
      deriveExecution(expectedVersion: number, receipt: PlanWriteReceipt) {
        if (!taskAuthority) throw new Error("standalone planning cannot derive execution");
        checkTaskAuthority(taskAuthority);
        checkAuthority(authority);
        const current = store.fence(authority.fence);
        if (current.version !== expectedVersion || current.phase !== "planning") throw new Error("stale task transition");
        const registered = taskFreezeReceipt(store, current);
        if (!registered || JSON.stringify(registered) !== JSON.stringify(receipt)) throw new Error("unregistered task FreezeReceipt");
        assertPlanningQuiescent(authority);
        if (owner.planning?.read().fileHash !== receipt.newHash) throw new Error("FreezeReceipt no longer applies");
        if (!owner.slotProducer?.observe("host-operation", "closed", true)) throw new Error("planning slot remains unsettled");
        checkTaskAuthority(taskAuthority);
        const plan = withCallContext({ kind: "managed", authority }, () =>
          openExecutionPlan(planId, store.root, { createLedger: false }));
        const next: RunRecord = { ...current, phase: "execution", phaseEpoch: current.phaseEpoch + 1,
          version: current.version + 1, binding: JSON.stringify(plan.binding), lastFactAt: new Date().toISOString(),
          task: { ...current.task!, freezeReceiptRef: receipt.receiptId } };
        store.transaction(() => {
          checkAuthority(authority);
          store.put("runs", next.runId, next);
          store.enqueue(`run:${next.runId}`, next.binding, { kind: "phase-derived", receiptId: receipt.receiptId, phaseEpoch: next.phaseEpoch });
        });
        owner.run = next; owner.binding = Object.freeze({ ...plan.binding });
        owner.planning = undefined; owner.slotProducer = undefined; owner.slotReservation = undefined;
        const execution = Object.freeze({ fence: Object.freeze({ runId: next.runId, ownerId: next.ownerId, epoch: next.epoch, phaseEpoch: next.phaseEpoch }) });
        authorities.set(execution, owner);
        checkAuthority(execution);
        withCallContext({ kind: "managed", authority: execution }, () => openExecutionPlan(planId, store.root, { createLedger: true }));
        checkAuthority(execution);
        return { authority: execution, context: { kind: "managed", authority: execution } as const };
      },
      current: () => owner.active && owner.run.state !== "completed",
      readBoundPlan: () => { checkAuthority(authority); return owner.planning ? owner.planning.read() : verifyExecutionBinding(owner.binding!); },
      async completePlanning(receipt: PlanWriteReceipt): Promise<void> {
        checkAuthority(authority);
        if (owner.run.activity !== "plan" || owner.run.state !== "active" || retiring)
          throw new Error("standalone planning is not active");
        const accepted = store.all<{ kind?: string; runId?: string; receipt?: PlanWriteReceipt }>("dispositions")
          .some(item => item.kind === "planning-acceptance" && item.runId === owner.run.runId &&
            JSON.stringify(item.receipt) === JSON.stringify(receipt));
        if (!accepted || owner.planning?.read().fileHash !== receipt.newHash) throw new Error("unregistered planning FreezeReceipt");
        assertPlanningQuiescent(authority);
        // Retain read-only receipt/lifecycle access, but close admission before joining observers.
        owner.run = { ...owner.run, state: "retiring", version: owner.run.version + 1 };
        store.transaction(() => store.put("runs", owner.run.runId, owner.run));
        const settled = Promise.withResolvers<void>();
        retiring = settled.promise; // Publish ownership before invoking reentrant retirement hooks.
        void retiring.catch(() => {});
        void (async () => {
          const results = await Promise.allSettled([...owner.retire].map(close => {
            try { return close(); } catch (error) { return Promise.reject(error); }
          }));
          const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, "planning completion retirement");
          if (store.all<Reservation>("reservations").some(item => item.runId === owner.run.runId &&
              item.reservationId !== owner.slotReservation?.reservation.reservationId &&
              item.state !== "released"))
            throw new Error("planning resources remain active or unknown");
          if (!owner.slotProducer?.observe("host-operation", "closed", true)) throw new Error("planning slot remains unsettled");
          owner.run = { ...owner.run, state: "completed", version: owner.run.version + 1, lastFactAt: new Date().toISOString() };
          store.transaction(() => {
            store.put("runs", owner.run.runId, owner.run);
            store.enqueue(`run:${owner.run.runId}`, owner.run.binding, { kind: "planning-completed", receiptId: receipt.receiptId });
          });
          owner.unlock();
          for (const listener of owner.listeners) listener();
        })().then(settled.resolve, settled.reject);
        await retiring;
      },
      async retire(): Promise<ActivityRetirement> {
        const callback = activityObservers.getStore();
        const self = callback?.owner === owner && callback.active;
        // Fence synchronously, including while a previous turn or callback is suspended.
        owner.active = false;
        if (!retiring) {
          const accepted = Promise.withResolvers<void>();
          retiring = accepted.promise; // Own settlement before invoking a reentrant retirement hook.
          void retiring.catch(() => {});
          const callbacks = [...owner.retire].map(close => { try { return close(); } catch (error) { return Promise.reject(error); } });
          void Promise.allSettled(callbacks).then(results => {
            const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            store.transaction(() => {
              const latest = owner.run;
              if (latest.state !== "completed") latest.state = errors.length ? "interrupted" : "retiring";
              latest.version++; latest.lastFactAt = new Date().toISOString();
              store.put("runs", latest.runId, latest); store.enqueue(`run:${latest.runId}`, latest.binding, { kind: "retired" });
            });
            if (errors.length) throw new AggregateError(errors, "workflow observation retirement");
            if (owner.slotProducer) {
              const receipt = owner.slotProducer.observe("host-operation", "closed", true);
              if (!receipt) throw new Error("planning resources remain unsettled; owner lock retained");
            }
            owner.unlock();
            for (const listener of owner.listeners) listener();
          }).then(accepted.resolve, accepted.reject);
        }
        // An observer may request retirement, but cannot join its own accepted frontier.
        if (self) return { kind: "requested" };
        await retiring;
        return { kind: "closed" };
      },
    };
  } catch (error) {
    // Once admitted, a failed recovery/persistence step is not proof of release.
    if (!slotReservation) { unownedGuard?.close(); unlock?.(); store.close(); }
    throw error;
  }
}
export function statusOwner(read: StatusReadAuthority) {
  const owner = readers.get(read);
  if (!owner) throw new Error("unregistered status reader");
  return owner;
}
export function liveProducer(ref: ResourceRef): Producer | undefined {
  const producer = liveProducers.get(ref.resourceId);
  return producer && sameResource(producer.ref, ref) && producer.live ? producer : undefined;
}
function sameResource(a: ResourceRef | undefined, b: ResourceRef): boolean {
  return !!a && a.resourceId === b.resourceId && a.producerId === b.producerId &&
    a.reservationId === b.reservationId && a.generation === b.generation;
}
export type WaitResult = { kind: "ready" } | { kind: "waiting"; cancel: () => void } |
  { kind: "deferred"; reason: "host-return-dependent" } | { kind: "unavailable"; reason: string };
export function waitForProducer(authority: PhaseAuthority, ref: ResourceRef | undefined, afterSequence: number,
  ready: () => void, dependency: "independent" | "host-return-dependent" = "independent"): WaitResult {
  return installProducerWait(authority, ref, afterSequence, ready, dependency);
}
function installProducerWait(authority: PhaseAuthority, ref: ResourceRef | undefined, afterSequence: number,
  ready: () => void, dependency: "independent" | "host-return-dependent", commit: () => void = () => {}): WaitResult {
  const owner = checkAuthority(authority);
  if (dependency === "host-return-dependent") return { kind: "deferred", reason: dependency };
  if (!ref) return { kind: "unavailable", reason: "no independent producer" };
  const producer = liveProducer(ref);
  if (!producer) return { kind: "unavailable", reason: "producer interrupted or unavailable" };
  if (producer.dependency === "host-return-dependent") return { kind: "deferred", reason: producer.dependency };
  const reservation = owner.store.get<Reservation>("reservations", ref.reservationId);
  if (!reservation || reservation.runId !== owner.run.runId || reservation.ownerId !== owner.run.ownerId)
    return { kind: "unavailable", reason: "producer belongs to another owner" };
  if (reservation.generation !== ref.generation || reservation.state === "released" || producer.snapshot().purpose !== "work")
    return { kind: "unavailable", reason: "producer reservation is unavailable" };
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > producer.cursor)
    return { kind: "unavailable", reason: "producer cursor is unavailable" };
  let accepted = false;
  let installed = false;
  let committed = false;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let stopCommit: (() => void) | undefined;
  const waitId = randomUUID();
  const stop = () => { stopped = true; unsubscribe?.(); stopCommit?.(); owner.retire.delete(retire); };
  const retire = async () => { stop(); };
  const reconsider = () => {
    if (!committed || stopped) return;
    try { checkAuthority(authority); } catch { stop(); return; }
    const resource = producer.snapshot();
    if (producer.cursor >= afterSequence && resource.sealed && resource.scopes.every(scope => resource.facts[scope] === "closed")) {
      stop();
      const resumed = owner.store.transaction(() => {
        const run = owner.store.fence(authority.fence);
        const latest = owner.store.all<{ kind: string; runId?: string; waitId?: string }>("dispositions")
          .filter(item => item.kind === "wait" && item.runId === run.runId).at(-1);
        if (latest?.waitId === waitId && sameResource(run.waitRef, ref)) {
          delete run.waitRef; run.state = "active"; run.version++; run.lastFactAt = new Date().toISOString();
          owner.store.put("runs", run.runId, run);
          return true;
        }
        return false;
      });
      if (resumed) { accepted = true; ready(); }
    }
  };
  // Use the existing reducer's post-commit port only for installation. Even a
  // reentrant host reduction must not publish readiness ahead of its outer commit.
  stopCommit = owner.store.subscribe(() => {
    if (!installed || stopped) return;
    stopCommit?.(); stopCommit = undefined;
    if (!owner.store.get("dispositions", waitId)) { stop(); return; }
    committed = true;
    reconsider(); // Install/commit/re-read, including readiness during subscribe.
  });
  try {
    unsubscribe = producer.subscribe(reconsider);
    owner.store.transaction(() => {
      const run = owner.store.fence(authority.fence);
      commit();
      run.state = "waiting"; run.waitRef = ref; run.version++; run.lastFactAt = new Date().toISOString();
      owner.store.put("runs", run.runId, run);
      owner.store.put("dispositions", waitId, { kind: "wait", waitId, runId: run.runId, ref, afterSequence });
      installed = true;
    });
  } catch (error) { stop(); throw error; }
  if (!stopped) owner.retire.add(retire);
  if (accepted) return { kind: "ready" };
  return { kind: "waiting", cancel: stop };
}

export type Obligation = {
  obligationId: string; unitId: string; kind: "implementation" | "verification" | "correction" | "required-closeout";
  origin: string; grantEpoch: number; requirements: readonly string[]; cleared: boolean;
};
export type ResultChoice =
  | { kind: "continue"; admissionId: string }
  | { kind: "wait"; producerRef: ResourceRef; afterSequence: number }
  | { kind: "consult"; assignmentId: string; question: string }
  | { kind: "diagnose"; missingEvidence: string; safeRemainingWork: string }
  | { kind: "accept"; resultRefs: string[]; evidenceRefs: string[]; reviewClaim: string }
  | { kind: "user-decision"; question: string; options: string[]; boundary: string; evidenceRefs: string[] };
export type Disposition = { kind: "continue" | "retry" | "correct" | "phase-complete" | "fail" | "report";
  obligationId: string; unitId: string; reason: string } |
  { kind: "defer"; obligationId: string; unitId: string; reason: "host-return-dependent" } |
  { kind: "result-disposition"; obligationId: string; unitId: string; resultId: string; expectedVersion: number;
    reason: string; choice: ResultChoice };
/** Shared storage/admission only. D owns continuation scheduling and proof arbitration. */
export function recordObligation(authority: PhaseAuthority, obligation: Obligation): void {
  const owner = checkAuthority(authority);
  if (!["active", "waiting"].includes(owner.run.state)) throw new Error(`workflow activity is ${owner.run.state}`);
  if (!obligation.unitId || !obligation.origin || obligation.grantEpoch !== authority.fence.epoch)
    throw new Error("obligation grant does not match the live owner");
  owner.store.transaction(() => {
    owner.store.fence(authority.fence);
    const previous = owner.store.get<Obligation & { runId: string }>("obligations", obligation.obligationId);
    if (previous && (previous.runId !== owner.run.runId || previous.unitId !== obligation.unitId ||
        previous.grantEpoch !== obligation.grantEpoch)) throw new Error("obligation belongs to another grant");
    owner.store.put("obligations", obligation.obligationId, { ...obligation, runId: owner.run.runId });
    owner.store.enqueue(`obligation:${obligation.obligationId}`, owner.run.binding, obligation);
  });
}
export function recordDisposition(authority: PhaseAuthority, disposition: Disposition): void {
  const owner = checkAuthority(authority);
  if (!["active", "waiting"].includes(owner.run.state)) throw new Error(`workflow activity is ${owner.run.state}`);
  if (!disposition.reason.trim()) throw new Error("disposition requires a reasoned claim");
  const commit = () => owner.store.transaction(() => {
    owner.store.fence(authority.fence);
    if (disposition.kind === "result-disposition") {
      const obligation = owner.store.get<ResultObligation>("obligations", disposition.obligationId);
      if (!obligation || obligation.runId !== owner.run.runId || obligation.unitId !== disposition.unitId ||
          obligation.resultId !== disposition.resultId || obligation.version !== disposition.expectedVersion ||
          obligation.state !== "disposition-required" || !obligation.boundary || obligation.cleared)
        throw new Error("result disposition requires its exact effective receipt/boundary and version");
      const manager = owner.manager as { getBranch?: () => readonly unknown[] };
      if (!(manager.getBranch?.() ?? []).some(entry => typeof entry === "object" && entry && "id" in entry &&
          entry.id === obligation.receipt?.entryId && receiptInBranch(obligation.message, [entry])))
        throw new Error("result disposition has no exact receipt in the current branch");
      checkAuthority(authority);
      const choice = disposition.choice;
      const references = (refs: string[]) => {
        if (!refs.length || new Set(refs).size !== refs.length) throw new Error("explicit distinct result references required");
        return refs.map(ref => {
          const result = owner.store.get<ResultObligation>("obligations", ref);
          if (!result?.resultId || result.runId !== owner.run.runId) throw new Error("foreign result reference");
          return result;
        });
      };
      if (choice.kind === "continue" && choice.admissionId !== owner.run.runId)
        throw new Error("continue requires the current captured admission");
      if (choice.kind === "consult") {
        const attempt = owner.store.all<AttemptRecord>("attempts").find(item => item.assignmentId === choice.assignmentId);
        if (!choice.question.trim() || !attempt || !["architect", "reviewer", "oracle", "researcher", "scout"].includes(attempt.roleId) ||
            owner.store.get<Reservation>("reservations", attempt.reservationId)?.runId !== owner.run.runId)
          throw new Error("consult requires a real owned consultation and question");
      }
      if (choice.kind === "diagnose" && (!choice.missingEvidence.trim() || !choice.safeRemainingWork.trim()))
        throw new Error("diagnosis requires missing evidence and safe remaining work");
      if (choice.kind === "accept") {
        const results = [...references(choice.resultRefs), ...references(choice.evidenceRefs)];
        if (!choice.resultRefs.includes(obligation.obligationId) || !choice.reviewClaim.trim())
          throw new Error("accept requires the selected result and a reasoned review claim");
        if (owner.store.all<(Obligation | ResultObligation) & { runId?: string }>("obligations").some(item =>
          item.runId === owner.run.runId && item.unitId === obligation.unitId && item.kind !== "result" && !item.cleared))
          throw new Error("accept has outstanding unit obligations");
        for (const result of results) {
          const attempt = owner.store.get<AttemptRecord>("attempts", result.dispatchId);
          if (!attempt?.outcome || owner.store.get<Reservation>("reservations", attempt.reservationId)?.state !== "released")
            throw new Error("accept requires recorded outcomes and released resource barriers");
        }
        obligation.cleared = true; // This result claim only; never a phase/run completion or hold release.
      }
      if (choice.kind === "user-decision") {
        references(choice.evidenceRefs);
        if (!choice.question.trim() || !choice.boundary.trim() || choice.options.length < 2 ||
            choice.options.some(option => !option.trim()) || new Set(choice.options).size !== choice.options.length)
          throw new Error("user-decision requires a concrete choice outside the current envelope");
      }
      owner.store.put("obligations", obligation.obligationId, { ...obligation, version: obligation.version + 1 });
      owner.store.put("dispositions", randomUUID(), { ...disposition, runId: owner.run.runId, fence: authority.fence });
      owner.store.enqueue(`disposition:${owner.run.runId}`, owner.run.binding, disposition);
      return;
    }
    const obligation = owner.store.get<Obligation & { runId: string }>("obligations", disposition.obligationId);
    if (!obligation || obligation.runId !== owner.run.runId || obligation.unitId !== disposition.unitId ||
        obligation.grantEpoch !== owner.run.epoch) throw new Error("disposition has no matching obligation grant");
    if (disposition.kind === "phase-complete" && !obligation.cleared) throw new Error("obligation remains uncleared");
    owner.store.put("dispositions", randomUUID(), { ...disposition, runId: owner.run.runId });
    owner.store.enqueue(`disposition:${owner.run.runId}`, owner.run.binding, disposition);
  });
  if (disposition.kind === "result-disposition" && disposition.choice.kind === "wait") {
    const prepare = resultWaitSources.get(authority)?.get(disposition.obligationId);
    if (!prepare) throw new Error("original result owner notification is unavailable");
    const ready = prepare(disposition);
    const waiting = installProducerWait(authority, disposition.choice.producerRef, disposition.choice.afterSequence,
      ready, "independent", commit);
    if (waiting.kind === "unavailable" || waiting.kind === "deferred") throw new Error(waiting.reason);
  } else commit();
  if (disposition.kind === "result-disposition" && disposition.choice.kind === "user-decision")
    projectUserDecisions(authority);
}

/** A committed decision and its exact ledger projection have separate outcomes.
 * Inspection retries the durable outbox; it never records the decision again. */
function projectUserDecisions(authority: PhaseAuthority, retry = true) {
  const owner = checkAuthority(authority);
  const accepts = (entry: ReturnType<WorkflowState["outbox"]>[number]) => {
    const body = entry.body as Partial<Extract<Disposition, { kind: "result-disposition" }>>;
    return entry.target === `disposition:${owner.run.runId}` &&
      body.kind === "result-disposition" && body.choice?.kind === "user-decision";
  };
  if (retry) owner.store.project(entry => {
    if (!owner.binding) return "not-applicable"; // Planning has no execution ledger.
    if (entry.binding !== JSON.stringify(owner.binding)) throw new Error("user decision projection binding is stale");
    writeExecutionUserDecision(owner.binding, "USER_DECISION_REQUIRED");
    return "applied";
  }, accepts);
  return owner.store.outbox().filter(accepts).map(entry => ({
    sequence: entry.sequence, state: entry.state,
    diagnostic: (entry.body as { projectionDiagnostic?: string }).projectionDiagnostic,
  }));
}

function registerResultDispositionTool(pi: ExtensionAPI): void {
  const strict = { additionalProperties: false } as const, text = Type.String({ minLength: 1 });
  const reference = Type.Object({ resourceId: text, producerId: text, reservationId: text, generation: Type.Integer({ minimum: 0 }) }, strict);
  guardToolRegistrations(pi, "read").registerTool({
    name: "execution_disposition", label: "Inspect or dispose a result obligation",
    description: "Foreground managed coordinator only. Record explicit reasoned claims after exact receipt and an effective turn boundary. Continue does not dispatch; wait/consult/diagnose do not accept or release; accept covers only the named result, never phase/run completion.",
    parameters: Type.Union([
      Type.Object({ op: Type.Literal("inspect") }, strict),
      Type.Object({ op: Type.Literal("record"), obligationId: text, expectedVersion: Type.Integer({ minimum: 1 }), reason: text,
        choice: Type.Union([
          Type.Object({ kind: Type.Literal("continue"), admissionId: text }, strict),
          Type.Object({ kind: Type.Literal("wait"), producerRef: reference, afterSequence: Type.Integer({ minimum: 0 }) }, strict),
          Type.Object({ kind: Type.Literal("consult"), assignmentId: text, question: text }, strict),
          Type.Object({ kind: Type.Literal("diagnose"), missingEvidence: text, safeRemainingWork: text }, strict),
          Type.Object({ kind: Type.Literal("accept"), resultRefs: Type.Array(text), evidenceRefs: Type.Array(text), reviewClaim: text }, strict),
          Type.Object({ kind: Type.Literal("user-decision"), question: text, options: Type.Array(text), boundary: text, evidenceRefs: Type.Array(text) }, strict),
        ]) }, strict),
    ]),
    async execute(_id, input, _signal, _update, ctx) {
      if (isChildSession(ctx)) throw new Error("AgentInstances cannot control foreground result disposition");
      const context = captureCallContext(ctx.cwd, ctx.sessionManager);
      if (context.kind !== "managed") throw new Error("result disposition requires the original managed activity");
      const authority = context.authority, owner = checkAuthority(authority);
      if (owner.manager !== ctx.sessionManager) throw new Error("result disposition owner mismatch");
      if (input.op === "record") {
        const obligation = owner.store.get<ResultObligation>("obligations", input.obligationId);
        if (!obligation?.resultId || obligation.runId !== owner.run.runId ||
            !receiptInBranch(obligation.message, ctx.sessionManager.getBranch()))
          throw new Error("result disposition has no exact receipt in the current branch");
        checkAuthority(authority);
        recordDisposition(authority, { ...input, kind: "result-disposition", unitId: obligation.unitId, resultId: obligation.resultId });
      }
      const userDecisionProjections = projectUserDecisions(authority, input.op === "inspect");
      const details = { admissionId: owner.run.runId, userDecisionProjections,
        waitProducers: [...liveProducers.values()].filter(producer => {
          const reservation = owner.store.get<Reservation>("reservations", producer.ref.reservationId);
          return producer.live && producer.dependency === "independent" &&
            reservation?.runId === owner.run.runId && reservation.ownerId === owner.run.ownerId &&
            reservation.generation === producer.ref.generation && reservation.state !== "released" &&
            producer.snapshot().purpose === "work";
        }).map(producer => ({ producerRef: producer.ref, afterSequence: producer.cursor, adapter: producer.snapshot().adapter })),
        obligations: owner.store.all<ResultObligation>("obligations").filter(item => item.runId === owner.run.runId && item.resultId)
          .map(({ message: _privateExactReceipt, ...item }) => item),
        dispositions: owner.store.all<{ runId?: string }>("dispositions").filter(item => item.runId === owner.run.runId) };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}

/** Foreground admission; composed shutdown returns retirement to the early lifecycle owner. */
export function registerWorkflowCommands(pi: ExtensionAPI): void;
export function registerWorkflowCommands(pi: ExtensionAPI, options: { shutdown: false }): () => Promise<void>;
export function registerWorkflowCommands(pi: ExtensionAPI, options?: { shutdown: false }): void | (() => Promise<void>) {
  let invocation: { identity: string; manager: object; sessionId: string; activity: ReturnType<typeof openActivity>; unbind: () => void; cleanup?: () => void; executePolicy?: string; taskId?: string } | undefined;
  let pending: { identity: string; manager: object; sessionId: string; ticket: number; taskId?: string } | undefined;
  const sendTurn = (activity: ReturnType<typeof openActivity>, context: CallContext, effect: () => void) => {
    const current = invocation, ticket = revision;
    if (!current || current.activity !== activity) throw new Error("workflow turn owner retired");
    const manager: NativeSession = current.manager;
    const owns = () => invocation === current && revision === ticket && current.manager === manager &&
      current.sessionId === manager.getSessionId?.() && activity.current();
    return withReceiverContext(manager, context, owns, effect);
  };
  const sendTaskTurn = (activity: ReturnType<typeof openActivity>, context: CallContext, authority: PhaseAuthority, policy: string, resume = false) => {
    const owner = checkAuthority(authority), run = owner.store.fence(authority.fence);
    const key = `task-turn:${run.task!.intentId}:${run.phaseEpoch}${resume ? `:resume:${run.epoch}` : ""}`;
    const previous = owner.store.get<{ state: string }>("obligations", key);
    if (previous?.state === "sent") return;
    if (previous) throw new Error("task turn delivery uncertain; inspect exact outbox before recovery");
    const message = { customType: "pitako.workflow.task", deliveryId: key,
      content: deliveryContent("context", { producer: "workflow-task", ownerSessionId: run.sessionId,
        foregroundRevision: run.epoch }, {
        policy, runId: run.runId, planId: run.planId, intentId: run.task!.intentId, phase: run.phase,
        phaseEpoch: run.phaseEpoch, resume,
        instruction: `${run.phase === "planning" ? "Plan the work requested in the current conversation, preserving its goals and constraints. The host has chosen the local plan ID; do not ask the user for one. " : ""}Use the existing ${run.phase} operations. Planning completion derives execution automatically, never a standalone /execute or a new human instruction. No publication.`,
      }, run.phase, key),
      display: true, details: { runId: run.runId, phaseEpoch: run.phaseEpoch, key } };
    owner.store.transaction(() => {
      owner.store.put("obligations", key, { kind: "phase-turn", key, message, state: "reserved", cleared: false, runId: run.runId });
      owner.store.enqueue(`run:${run.runId}`, run.binding, { kind: "task-phase-turn", key, message, phaseEpoch: run.phaseEpoch });
    });
    checkAuthority(authority);
    sendTurn(activity, context, () => pi.sendMessage(message, { triggerTurn: true }));
    owner.store.transaction(() => owner.store.put("obligations", key,
      { kind: "phase-turn", key, message, state: "sent", cleared: true, runId: run.runId }));
  };
  registerPlanningTools(pi, {
    async afterFreeze(authority, receipt) {
      const current = invocation;
      if (!current?.activity.taskAuthority || current.activity.authority !== authority) {
        // An old planning callback cannot derive a new phase after Stop/replacement.
        const owner = checkAuthority(authority);
        if (owner.run.activity === "task") throw new Error("task invocation no longer owns planning");
        if (current?.activity.authority !== authority) throw new Error("planning invocation no longer owns Freeze");
        await current.activity.completePlanning(receipt);
        return;
      }
      const owner = checkTaskAuthority(current.activity.taskAuthority);
      // Wait reductions advance the durable run without replacing the captured owner record.
      const run = owner.store.fence(authority.fence);
      const next = current.activity.deriveExecution(run.version, receipt);
      current.unbind();
      current.unbind = bindCallContext(current.manager, next.context);
      sendTaskTurn(current.activity, next.context, next.authority, current.executePolicy!);
    },
  });
  registerResultDispositionTool(pi);
  registerTaskTools(pi, manager => invocation?.manager === manager ? invocation.activity.taskAuthority : undefined,
    async manager => { if (invocation?.manager === manager) await retire(); });
  let retirement: Promise<void> = Promise.resolve();
  let revision = 0;
  const retire = () => {
    revision++;
    pending = undefined;
    const old = invocation;
    invocation = undefined;
    if (!old) return retirement;
    old.cleanup?.();
    old.unbind();
    const closing = old.activity.retire(); // Synchronous fence precedes the first await.
    retirement = Promise.all([retirement, closing]).then(() => {});
    void retirement.catch(() => {});
    return retirement;
  };
  const reject = (ctx: ExtensionCommandContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, "error"); else console.error(message);
  };
  pi.registerCommand("execute", {
    description: "Execute a locally bound frozen plan",
    async handler(args, ctx) {
      let pendingTicket: number | undefined;
      try {
        if (isChildSession(ctx)) throw new Error("AgentInstances have bound-plan read only, not foreground workflow control");
        const match = /^([a-z0-9][a-z0-9._-]*)$/.exec(args.trim());
        if (!match) throw new Error("usage: /execute <frozen-plan-id>");
        // Validate all inputs before retiring a different valid invocation or entering a turn.
        const plan = openExecutionPlan(match[1]!, ctx.cwd, { createLedger: true });
        const policy = readFileSync(path.join(packageRoot(), "skills", "execute", "SKILL.md"), "utf8");
        if (!policy.trim()) throw new Error("packaged execute policy is unavailable");
        const manager = ctx.sessionManager;
        const sessionId = manager.getSessionId();
        const identity = JSON.stringify(plan.binding);
        if (invocation?.identity === identity && invocation.manager === manager && invocation.activity.current()) return;
        const closing = retire(), ticket = revision;
        pendingTicket = ticket;
        pending = { identity, manager, sessionId, ticket };
        await closing;
        await ctx.waitForIdle();
        if (ticket !== revision) throw new Error("workflow invocation superseded before turn");
        verifyExecutionBinding(plan.binding);
        if (manager !== ctx.sessionManager || sessionId !== manager.getSessionId()) throw new Error("workflow invocation session changed");
        const activity = openExecuteActivity(plan, manager, sessionId);
        let unbind: () => void;
        try { unbind = bindCallContext(manager, activity.context); }
        catch (error) { await activity.retire(); throw error; }
        invocation = { identity, manager, sessionId, activity, unbind };
        pending = undefined;
        if (ctx.signal?.aborted) { await retire(); throw new Error("workflow invocation aborted"); }
        ctx.signal?.addEventListener("abort", () => { if (invocation?.activity === activity) void retire(); }, { once: true });
        sendTurn(activity, activity.context, () => pi.sendMessage({ customType: "pitako.workflow.execute",
          content: `${policy}\n\nNative /execute invocation. Frozen binding:\n${identity}`,
          display: true, details: { runId: activity.authority.fence.runId, source: "frozen" } },
        { triggerTurn: true }));
      } catch (error) { reject(ctx, error); }
      finally { if (pendingTicket !== undefined && pending?.ticket === pendingTicket) pending = undefined; }
    },
  });
  pi.registerCommand("plan", {
    description: "Plan in one local host-managed slot",
    async handler(args, ctx) {
      let pendingTicket: number | undefined;
      try {
        if (isChildSession(ctx)) throw new Error("AgentInstances have bound-plan read only, not foreground workflow control");
        const match = /^([a-z0-9][a-z0-9_-]*)(?:\s+(--reopen))?$/.exec(args.trim());
        if (!match) throw new Error("usage: /plan <local-plan-id> [--reopen]");
        const root = currentWorkspace(ctx.cwd), id = match[1]!, expected = snapshotPlan(id, root);
        const reopen = !!match[2];
        if (expected.meta && expected.meta.status !== "draft" && !(reopen && expected.meta.status === "frozen"))
          throw new Error("planning requires an absent/draft local slot; frozen requires explicit --reopen");
        if (reopen && (existsSync(ledgerFile(id, root)) || readExecutionBinding(id, root)))
          throw new Error("frozen source is pinned by execution");
        const policy = readFileSync(path.join(packageRoot(), "skills", "plan", "SKILL.md"), "utf8");
        if (!policy.trim()) throw new Error("packaged plan policy is unavailable");
        const manager = ctx.sessionManager, sessionId = manager.getSessionId();
        const identity = JSON.stringify({ activity: "plan", root, id, reopen });
        if (invocation?.identity === identity && invocation.manager === manager && invocation.activity.current()) return;
        const closing = retire(), ticket = revision;
        pendingTicket = ticket;
        pending = { identity, manager, sessionId, ticket };
        await closing;
        await ctx.waitForIdle();
        if (ticket !== revision || manager !== ctx.sessionManager || sessionId !== manager.getSessionId())
          throw new Error("workflow invocation superseded or session changed before turn");
        if (JSON.stringify(snapshotPlan(id, root)) !== JSON.stringify(expected)) throw new Error("planning slot changed before turn");
        const activity = openPlanActivity(id, root, expected, manager, sessionId);
        let unbind: () => void;
        try {
          if (reopen) planningSlot(activity.authority).reopen(expected);
          unbind = bindCallContext(manager, activity.context);
        } catch (error) { await activity.retire(); throw error; }
        invocation = { identity, manager, sessionId, activity, unbind };
        pending = undefined;
        if (ctx.signal?.aborted) { await retire(); throw new Error("workflow invocation aborted"); }
        ctx.signal?.addEventListener("abort", () => { if (invocation?.activity === activity) void retire(); }, { once: true });
        sendTurn(activity, activity.context, () => pi.sendMessage({ customType: "pitako.workflow.plan", content: `${policy}\n\nNative managed /plan. Local slot ${id}; host revision ${String(activity.readBoundPlan().meta?.revision ?? "absent")}. Use planning operations; no generic writes or execution ledger.`,
          display: true, details: { runId: activity.authority.fence.runId, source: "draft" } }, { triggerTurn: true }));
      } catch (error) { reject(ctx, error); }
      finally { if (pendingTicket !== undefined && pending?.ticket === pendingTicket) pending = undefined; }
    },
  });
  pi.registerCommand("task", {
    description: "Plan and execute the current conversation locally; optional local plan ID, no publication",
    async handler(args, ctx) {
      let cleanup: (() => void) | undefined;
      let pendingTicket: number | undefined;
      try {
        if (isChildSession(ctx)) throw new Error("AgentInstances have bound-plan read only, not foreground task control");
        const input = args.trim(), match = /^([a-z0-9][a-z0-9_-]*)$/.exec(input);
        if (input && !match) throw new Error("usage: /task [local-plan-id]");
        const root = currentWorkspace(ctx.cwd);
        const manager = ctx.sessionManager, sessionId = manager.getSessionId();
        if (!input) {
          const current = pending ?? invocation;
          if (current?.manager === manager && current.sessionId === sessionId) {
            if (current.taskId && (pending === current || invocation?.activity.current())) return;
            if (!current.taskId) throw new Error("workflow already selected; use /task <local-plan-id> explicitly");
          }
          const state = new WorkflowState(root);
          try {
            const previous = state.all<RunRecord>("runs").filter(run =>
              run.activity === "task" && run.sessionId === sessionId && run.state !== "completed").at(-1);
            if (previous) throw new Error(`task already selected; use /task ${previous.planId} explicitly to inspect or resume`);
          } finally { state.close(); }
        }
        const id = match?.[1] ?? `task-${randomUUID()}`, expected = snapshotPlan(id, root);
        const identity = JSON.stringify({ activity: "task", root, id });
        if ((invocation?.identity === identity && invocation.manager === manager && invocation.activity.current()) ||
            (pending?.identity === identity && pending.manager === manager)) return;
        if (ctx.signal?.aborted) throw new Error("task invocation aborted");
        const policy = readFileSync(path.join(packageRoot(), "skills", "plan", "SKILL.md"), "utf8");
        const executePolicy = readFileSync(path.join(packageRoot(), "skills", "execute", "SKILL.md"), "utf8");
        if (!policy.trim() || !executePolicy.trim()) throw new Error("packaged task phase policy is unavailable");
        const state = new WorkflowState(root);
        let resume = false;
        let previousRun: RunRecord | undefined;
        try {
          const previous = state.all<RunRecord>("runs").filter(run => run.activity === "task" && run.planId === id).at(-1);
          previousRun = previous;
          if (previous?.state === "completed") throw new Error("task is already completed");
          if (previous && state.all<{ runId?: string; kind?: string; state?: string }>("obligations")
              .some(item => item.runId === previous.runId && item.kind === "phase-turn" && item.state !== "sent"))
            throw new Error("task turn delivery uncertain; exact outbox recovery required");
          const receipt = previous && taskFreezeReceipt(state, previous);
          if (expected.meta && expected.meta.status !== "draft" && !receipt)
            throw new Error("task requires draft or its registered FreezeReceipt");
          if (receipt && (receipt.newHash !== expected.fileHash || receipt.snapshot.text !== expected.text))
            throw new Error("task FreezeReceipt source changed");
          const ownedRun = invocation?.activity.authority.fence.runId;
          if (state.all<Reservation>("reservations").some(r => r.state !== "released" && r.runId !== ownedRun) ||
              state.all<TeamHoldRecord>("holds").some(h => !h.cleared))
            throw new Error("task capacity is held by active or unknown work");
          if (previous && previous.state !== "retiring" && previous.state !== "interrupted" && previous.runId !== ownedRun)
            throw new Error("task owner is not released; exact recovery required");
          resume = !!previous;
        } finally { state.close(); }
        const closing = retire(), ticket = revision;
        pendingTicket = ticket;
        pending = { identity, manager, sessionId, ticket, taskId: id };
        const abort = () => {
          if (pending?.ticket === ticket || invocation?.identity === identity && invocation.manager === manager) void retire();
        };
        ctx.signal?.addEventListener("abort", abort, { once: true });
        cleanup = () => ctx.signal?.removeEventListener("abort", abort);
        await closing;
        if (ctx.signal?.aborted || pending?.ticket !== ticket) throw new Error("task invocation revoked before idle");
        await ctx.waitForIdle();
        if (ctx.signal?.aborted || pending?.ticket !== ticket || ticket !== revision ||
            manager !== ctx.sessionManager || sessionId !== manager.getSessionId() || currentWorkspace(ctx.cwd) !== root)
          throw new Error("task invocation superseded or session changed before turn");
        if (JSON.stringify(snapshotPlan(id, root)) !== JSON.stringify(expected)) throw new Error("task source changed before turn");
        const recheck = new WorkflowState(root);
        try {
          const previous = recheck.all<RunRecord>("runs").filter(run => run.activity === "task" && run.planId === id).at(-1);
          if (previous?.runId !== previousRun?.runId || previous?.ownerId !== previousRun?.ownerId ||
              previous?.epoch !== previousRun?.epoch || previous?.phaseEpoch !== previousRun?.phaseEpoch ||
              previous?.task?.intentId !== previousRun?.task?.intentId)
            throw new Error("task predecessor fence changed before turn");
          if (recheck.all<Reservation>("reservations").some(r => r.state !== "released") ||
              recheck.all<TeamHoldRecord>("holds").some(h => !h.cleared))
            throw new Error("task capacity changed before turn");
        } finally { recheck.close(); }
        const activity = openTaskActivity(id, root, expected, manager, sessionId);
        let unbind: () => void;
        try { unbind = bindCallContext(manager, activity.context); }
        catch (error) { await activity.retire(); throw error; }
        invocation = { identity, manager, sessionId, activity, unbind, cleanup, executePolicy, taskId: id };
        pending = undefined; cleanup = undefined;
        if (ctx.signal?.aborted) { await retire(); throw new Error("task invocation aborted"); }
        if (checkAuthority(activity.authority).run.phase === "execution")
          withCallContext(activity.context, () => openExecutionPlan(id, root, { createLedger: true }));
        sendTaskTurn(activity, activity.context, activity.authority, checkAuthority(activity.authority).run.phase === "planning" ? policy : executePolicy, resume);
      } catch (error) { reject(ctx, error); }
      finally {
        cleanup?.();
        if (pendingTicket !== undefined && pending?.ticket === pendingTicket) pending = undefined;
      }
    },
  });
  pi.on("input", event => {
    if (/^\/(?:stop|abort)(?:\s|$)/.test(event.text)) void retire();
  });
  const retireObserved = (outcome: string | undefined, manager: ExtensionCommandContext["sessionManager"]) => {
    const owner = pending ?? invocation;
    if ((outcome === "aborted" || outcome === "error") && owner?.manager === manager &&
        owner.sessionId === manager.getSessionId()) void retire();
  };
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") retireObserved(event.message.stopReason, ctx.sessionManager);
  });
  pi.on("agent_before_settle", (event, ctx) => {
    retireObserved(event.outcome, ctx.sessionManager);
  });
  pi.on("agent_end", (event, ctx) => {
    const last = [...event.messages].reverse().find(message => message.role === "assistant");
    if (last?.role === "assistant") retireObserved(last.stopReason, ctx.sessionManager);
  });
  if (!options) pi.on("session_shutdown", async () => { await retire(); });
  pi.on("session_before_switch", async () => { await retire(); });
  pi.on("session_before_fork", async () => { await retire(); });
  if (options) return retire;
}
