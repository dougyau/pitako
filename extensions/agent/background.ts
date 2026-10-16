import { receiptInBranch, offerEnvelope } from "./delivery.ts";
import { PitakoConfigError } from "../errors.ts";
import { createPiExecutor } from "./pi.ts";
import { clearObservations, noteResultTaken, noteHandoff, observationEpoch, publishObservation, removeObservation, removeTeamObservations,
  publishActivityBinding, listObservations, retainTerminalActivity, noteTerminalActivityUnavailable, terminalActivityKey,
  removeOwnerTerminalActivity, touchObservation, type TerminalActivityKey } from "./observe.ts";
import { runAgentInstance, createConversationOwner, mergeUsage, createInstanceId, type AgentRunInput, type AgentRunResult, type AttemptExecutor } from "./run.ts";
import type { LoadOptions } from "../roles/load.ts";
import type { ExecutionBinding } from "../workflow.ts";
import type { LiveHandle } from "./live.ts";
import { randomUUID } from "node:crypto";
import { PublicConversation } from "./public-conversation.ts";
import { AgentClosureError, type AgentClosure } from "./closure.ts";
import { dispatchAdmissionsClosed } from "./dispatch.ts";
import type { HeadAttachment } from "./head/runtime.ts";

export interface WorkerInterest {
  planId: string;
  unitId: string;
  execution?: ExecutionBinding;
}

export interface TeamMetadata {
  teamId?: string;
  memberId?: string;
  turnId?: string;
}

export interface WorkerHandle extends TeamMetadata {
  instanceId: string;
  roleId: string;
  status: "running";
  watch: boolean;
  dispatchId?: string;
  dispatchPhase?: "preflight" | "worker" | "settled";
}

export type WorkerStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkerView extends TeamMetadata {
  instanceId: string;
  roleId: string;
  status: WorkerStatus;
  watch: boolean;
  elapsedMs: number;
  closure: AgentClosure;
  dispatchId?: string;
  dispatchPhase?: "preflight" | "worker" | "settled";
  workerStarted?: boolean;
}

export interface BackgroundOwner {
  token: symbol;
  sessionId?: string;
  revision?: number;
  owns?: () => boolean;
  isIdle: () => boolean;
  hasUI: boolean;
  notify: (message: string) => void;
  sendMessage: (content: string) => void;
  appendResult?: (message: ResultMessage) => void;
  appendIntermediate?: (message: IntermediateMessage) => void;
  getBranch?: () => readonly unknown[];
}

export interface ResultMessage {
  customType: "pitako.worker.result";
  content: string;
  display: true;
  details: {
    deliveryId: string;
    teamId?: string;
    memberId?: string;
    turnId?: string;
    instanceId: string;
    assignmentId?: string;
    ownerSessionId?: string;
    foregroundRevision?: number;
    status: AgentRunResult["status"];
    roleId: string;
    planId?: string;
    unitId?: string;
  };
}

export interface IntermediateMessage {
  customType: "pitako.architecture.response";
  content: string;
  display: true;
  details: { deliveryId: string; roomId: string; assignmentId: string; instanceId: string; turnId: string };
}
interface Intermediate {
  message: IntermediateMessage;
  delivery: WorkerHandoff["delivery"];
  continuation: WorkerHandoff["continuation"];
  deliveryAttempts: number; wakeAttempts: number; outstanding: boolean; busyContinuation: boolean;
  deliveryDiagnostic?: string;
}
export type Recipient = { kind: "protocol"; settle: (result: AgentRunResult, closure: AgentClosure) => void };

export interface WorkerHandoff {
  collection: "collected";
  bookkeeping: "pending" | "reconciled" | "inapplicable" | "blocked";
  delivery: "pending" | "offered" | "incorporated" | "blocked" | "dropped";
  continuation: "not-requested" | "requested" | "observed" | "blocked-unconfirmed";
  bookkeepingDiagnostic?: string;
  deliveryDiagnostic?: string;
  continuationDiagnostic?: string;
}

interface Handoff extends WorkerHandoff {
  readonly message: ResultMessage;
  bookkeepingAttempts: number;
  deliveryAttempts: number;
  wakeAttempts: number;
  outstanding: boolean;
  busyContinuation: boolean;
}

type SignalState = "pending" | "dropped";

interface Row extends TeamMetadata {
  recipient?: Recipient;
  intermediates?: Intermediate[];
  ready?: Promise<void>;
  preparation?: Promise<void>;
  maintained?: { owner: ReturnType<typeof createConversationOwner>; completion: ReturnType<typeof Promise.withResolvers<void>>;
    last?: AgentRunResult; usage?: AgentRunResult["usage"]; missingUsage: boolean;
    driver?: Promise<AgentRunResult>;
    turn?: Promise<AgentRunResult>; closing?: Promise<void>; stopAbort: () => void };
  instanceId: string;
  roleId: string;
  acceptedAt: number;
  interest?: WorkerInterest;
  controller: AbortController;
  outcome?: AgentRunResult;
  signal: SignalState;
  teamOwnerToken?: symbol;
  teamAssignmentId?: string;
  onTeamSettled?: (status: WorkerStatus) => void;
  deliveryOwner?: BackgroundOwner;
  reconcileBookkeeping?: (result: AgentRunResult) => void;
  handoff?: Handoff;
  ownerToken?: symbol;
  coordinatorSessionId?: string;
  live?: LiveHandle;
  generation: number;
  attemptId?: string;
  conversation?: PublicConversation;
  run: Promise<void>;
  closure: AgentClosure;
  dispatchId?: string;
  dispatchPhase?: "preflight" | "worker" | "settled";
  workerStarted?: boolean;
  releaseNoWorker?: () => void;
  preparationSettled?: boolean;
  launch?: { task: string; origin?: import("./history.ts").HistoryOrigin };
  consultation?: ReturnType<typeof import("./consultation.ts").consultationRecord>;
}

interface Bag {
  rows: Map<string, Row>;
  owner?: BackgroundOwner;
  teamOwners?: Map<symbol, BackgroundOwner>;
  restrictions: Map<symbol, "aborted" | "error">;
  executor?: AttemptExecutor;
}

const KEY = Symbol.for("pitako.backgroundWorkers");

function bag(): Bag {
  const host = globalThis as Record<symbol, Bag | undefined>;
  const existing = host[KEY];
  if (existing) {
    existing.teamOwners ??= new Map();
    return existing;
  }
  const created: Bag = { rows: new Map(), restrictions: new Map(), teamOwners: new Map() };
  host[KEY] = created;
  return created;
}

/** Recovery uses positive durable closure too; retained host owners can only veto it. */
export function assertCheckpointWorkersReleased(instanceId: string, assignmentId: string): void {
  for (const row of bag().rows.values()) {
    if (row.instanceId !== instanceId && row.teamAssignmentId !== assignmentId) continue;
    if (row.closure.state !== "released" || row.live ||
        row.handoff && !["reconciled", "inapplicable"].includes(row.handoff.bookkeeping)) {
      throw new Error(`checkpoint predecessor retains a live/unknown owner or bookkeeping hold: ${instanceId}`);
    }
  }
}

export function bindBackgroundOwner(owner: BackgroundOwner): void {
  const state = bag();
  state.owner = owner;
  state.teamOwners!.set(owner.token, owner);
}

export function clearBackgroundOwner(): void {
  const state = bag();
  state.owner = undefined;
  state.teamOwners?.clear();
}

/** Retire admission authority without aborting or pretending to join workers. */
export function revokeBackgroundOwner(token: symbol): void {
  const state = bag();
  for (const row of state.rows.values()) if (row.ownerToken === token) row.conversation?.retire();
  removeOwnerTerminalActivity(token);
  if (state.owner?.token === token) state.owner = undefined;
  state.teamOwners?.delete(token);
}

export function setBackgroundExecutor(executor: AttemptExecutor | undefined): void {
  bag().executor = executor;
}

export function backgroundExecutor(): AttemptExecutor {
  return bag().executor ?? createPiExecutor();
}

export interface SpawnInput {
  roleId: string;
  task: string;
  cwd: string;
  architecture?: AgentRunInput["architecture"];
  recipient?: Recipient;
  driver?: (signal: AbortSignal) => Promise<AgentRunResult>;
  historyOrigin?: import("./history.ts").HistoryOrigin;
  dispatch?: import("./routing.ts").DispatchSnapshot;
  consultation?: import("./consultation.ts").ConsultationSnapshot;
  /** Internal host reservation, never a tool parameter. */
  reservation?: Row;
  check?: () => void;
  head?: HeadAttachment;
  foreground?: AbortSignal;
  watch?: WorkerInterest;
  executor: AttemptExecutor;
  load?: LoadOptions;
  now?: () => number;
  maintained?: boolean;
  teamOwner?: { token: symbol; assignmentId: string; teamId?: string; memberId?: string; onSettled: (status: WorkerStatus) => void };
  reconcileBookkeeping?: (result: AgentRunResult) => void;
}

export async function spawnBackground(input: SpawnInput): Promise<WorkerHandle> {
  input.check?.();
  if (input.foreground?.aborted) throw new Error("agent_spawn cancelled");
  const controller = input.reservation?.controller ?? new AbortController();
  const now = input.now ?? Date.now;
  const epoch = observationEpoch();
  const ownerToken = input.reservation?.ownerToken ?? bag().owner?.token;
  let row: Row | undefined;
  const completion = Promise.withResolvers<void>();
  const runInput: AgentRunInput = {
    roleId: input.roleId,
    task: input.task,
    cwd: input.cwd,
    executionRoot: input.watch?.execution?.executionRoot,
    historyOrigin: input.historyOrigin,
    dispatch: input.dispatch,
    consultation: input.consultation,
    architecture: input.architecture,
    reservedInstanceId: input.reservation?.instanceId,
    head: input.head,
    signal: controller.signal,
    executor: {
      ...input.executor,
      start(attempt) {
        return input.executor.start({ ...attempt, bindLive(handle) {
          const accepted = row;
          if (!accepted || bag().rows.get(accepted.instanceId) !== accepted || accepted.controller.signal.aborted) {
            void handle.close();
            return () => {};
          }
          const previous = accepted.live;
          if (previous && previous !== handle) void previous.close();
          accepted.live = handle;
          accepted.generation++;
          const generation = accepted.generation;
          const { historyId, sessionId } = handle;
          if (accepted.conversation && handle.publicConversation) {
            handle.publicConversation.attach(accepted.conversation);
            if (accepted.attemptId) accepted.conversation.attempt(accepted.attemptId);
          }
          const key = () => {
            if (!currentReadRow(accepted, epoch) || accepted.live !== handle || accepted.generation !== generation ||
                handle.historyId !== historyId || handle.sessionId !== sessionId || !accepted.attemptId) return undefined;
            return activityKey(accepted, handle);
          };
          const initial = key();
          if (initial) publishActivityBinding(initial, epoch);
          handle.onChange = () => { if (key()) touchObservation(accepted.instanceId, epoch); };
          handle.onTerminalCapture = snapshot => {
            const current = key();
            if (current) retainTerminalActivity(current, snapshot, epoch);
          };
          handle.onTerminalCaptureFailed = reason => {
            const current = key();
            if (current) noteTerminalActivityUnavailable(current, reason, epoch);
          };
          return () => {
            if (accepted.live !== handle) return;
            const valid = key();
            accepted.live = undefined;
            handle.onChange = undefined;
            if (valid) touchObservation(accepted.instanceId, epoch);
          };
        } });
      },
    },
    load: input.load,
    now,
    onAccepted(instance) {
      input.check?.();
      if (input.foreground?.aborted) throw new Error("agent_spawn cancelled");
      if (input.reservation && instance.id !== input.reservation.instanceId) throw new Error("reserved worker identity mismatch");
      row = input.reservation ?? {
        instanceId: instance.id,
        roleId: instance.roleId,
        acceptedAt: now(),
        interest: input.watch,
        controller,
        signal: "pending",
        teamOwnerToken: input.teamOwner?.token,
        teamAssignmentId: input.teamOwner?.assignmentId,
        onTeamSettled: input.teamOwner?.onSettled,
        deliveryOwner: bag().owner,
        reconcileBookkeeping: input.reconcileBookkeeping,
        ownerToken,
        coordinatorSessionId: input.historyOrigin?.coordinatorSessionId,
        generation: 0,
        closure: { state: "pending" },
        run: completion.promise,
      };
      row.recipient = input.recipient;
      row.teamId = input.historyOrigin?.teamId ?? row.teamId;
      row.memberId = input.historyOrigin?.memberId ?? row.memberId;
      row.workerStarted = true;
      row.dispatchPhase = "worker";
      row.run = completion.promise;
      row.interest = input.watch;
      row.reconcileBookkeeping = input.reconcileBookkeeping;
      bag().rows.set(instance.id, row);
      if (ownerToken) {
        row.conversation = new PublicConversation(undefined, input.executor.capturesPublicConversation === true);
        row.conversation.bind(ownerToken);
        row.conversation.onChange = () => {
          if (row && currentReadRow(row, epoch)) touchObservation(row.instanceId, epoch);
        };
      }
    },
    onObserve(snapshot) {
      if (!row || bag().rows.get(row.instanceId) !== row || row.signal === "dropped" ||
          epoch !== observationEpoch() || row.ownerToken && bag().owner?.token !== row.ownerToken ||
          row.teamOwnerToken && !bag().teamOwners?.has(row.teamOwnerToken)) return;
      row.turnId = snapshot.turnId;
      row.attemptId = snapshot.attemptId;
      if (snapshot.attemptId && snapshot.activated?.attemptId === snapshot.attemptId)
        row.conversation?.attempt(snapshot.attemptId, snapshot.activated, { model: snapshot.selectedModel,
          requestedModel: snapshot.requestedModel, reasoning: snapshot.requestedReasoning });
      publishObservation(
        {
          ...snapshot,
          teamId: row.teamId, memberId: row.memberId,
          ...(input.maintained ? { status: "running" as const, terminalAt: undefined } : {}),
          acceptedAt: row.acceptedAt,
          planId: input.watch?.planId,
          unitId: input.watch?.unitId,
          teamOwnerToken: row.teamOwnerToken,
          ownerToken,
        },
        epoch,
      );
      if (row.live && row.attemptId && currentReadRow(row, epoch)) publishActivityBinding(activityKey(row, row.live), epoch);
    },
  };
  if (input.maintained) {
    if (!input.reservation || input.head) throw new Error("maintained conversations require a reserved non-Head Team member");
    row = input.reservation;
    row.run = completion.promise;
    row.workerStarted = true;
    row.dispatchPhase = "worker";
    row.interest = input.watch;
    row.reconcileBookkeeping = input.reconcileBookkeeping;
    row.recipient = input.recipient;
    const owner = createConversationOwner(runInput);
    row.maintained = { owner, completion, missingUsage: false, stopAbort: () => {} };
    const accepted = row;
    const cancel = () => { void finishTeamWorker(accepted.teamOwnerToken!, accepted.instanceId).catch(() => {}); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    row.maintained.stopAbort = () => controller.signal.removeEventListener("abort", cancel);
    if (input.driver) {
      row.maintained.driver = Promise.resolve().then(() => input.driver!(controller.signal));
      void row.maintained.driver.finally(() => finishTeamWorker(accepted.teamOwnerToken!, accepted.instanceId)).catch(() => {});
    }
    markConversationIdle(row, epoch);
    if (controller.signal.aborted) cancel();
    return { instanceId: row.instanceId, roleId: row.roleId, status: "running", watch: !!row.interest,
      teamId: row.teamId, memberId: row.memberId, dispatchId: row.dispatchId, dispatchPhase: row.dispatchPhase };
  }
  const pending = runAgentInstance(runInput);
  if (!row) {
    await pending;
    throw new Error("agent_spawn did not accept");
  }
  const accepted = row;
  void pending.then(
    (result) => {
      accepted.closure = { state: "released" };
      settle(accepted, result, epoch);
    },
    (error: unknown) => {
      accepted.closure = error instanceof AgentClosureError
        ? { state: "unknown", reason: error.message } : { state: "released" };
      settle(accepted, {
        instanceId: accepted.instanceId,
        role: accepted.roleId,
        status: "failed",
        model: { selectedModel: "unknown" },
        result: error instanceof Error ? error.message : String(error),
      }, epoch);
    },
  ).then(completion.resolve, error => {
    accepted.closure = { state: "unknown", reason: String(error) };
    completion.resolve();
  });
  return {
    instanceId: accepted.instanceId,
    roleId: accepted.roleId,
    status: "running",
    watch: accepted.interest !== undefined,
  };
}

/** Reserve before external work; the captured owner's macrotask cannot overtake the caller's continuation. */
export function reserveBackground(input: {
  roleId: string;
  coordinatorSessionId?: string;
  origin?: import("./history.ts").HistoryOrigin;
  task: string;
  owns: () => boolean;
  teamOwner?: { token: symbol; assignmentId: string; teamId?: string; memberId?: string; onSettled: (status: WorkerStatus) => void; noWorkerReleased: () => void };
  recipient?: Recipient;
  prepare: (signal: AbortSignal, check: () => void, row: { instanceId: string; dispatchId: string;
    record: (record: NonNullable<Row["consultation"]>) => void; current: () => boolean }) => Promise<SpawnInput>;
  cleanup?: () => Promise<void>;
}): WorkerHandle {
  if (dispatchAdmissionsClosed(input.coordinatorSessionId)) throw new Error("Dispatch cancelled before admission");
  const owner = input.teamOwner ? bag().teamOwners?.get(input.teamOwner.token) : bag().owner;
  if (!owner || owner.owns && !owner.owns() || !input.owns()) throw new Error("background owner unavailable or retired");
  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const row: Row = { recipient: input.recipient, instanceId: createInstanceId(input.roleId), roleId: input.roleId, dispatchId: randomUUID(),
    dispatchPhase: "preflight", workerStarted: false, acceptedAt: Date.now(), controller,
    ownerToken: owner.token, deliveryOwner: owner, coordinatorSessionId: input.coordinatorSessionId,
    teamOwnerToken: input.teamOwner?.token, teamAssignmentId: input.teamOwner?.assignmentId,
    teamId: input.teamOwner?.teamId, memberId: input.teamOwner?.memberId, ready: ready.promise, preparation: completion.promise,
    onTeamSettled: input.teamOwner?.onSettled, releaseNoWorker: input.teamOwner?.noWorkerReleased,
    generation: 0, signal: "pending", closure: { state: "pending" }, run: completion.promise,
    launch: { task: input.task, origin: input.origin && structuredClone(input.origin) } };
  bag().rows.set(row.instanceId, row);
  const check = () => {
    if (controller.signal.aborted || dispatchAdmissionsClosed(input.coordinatorSessionId) || !liveOwner(row) || !input.owns()) {
      controller.abort(); throw new Error("Dispatch cancelled before admission");
    }
  };
  publishObservation({ id: row.instanceId, roleId: row.roleId, task: input.task, status: "created",
    teamId: row.teamId, memberId: row.memberId,
    phase: "working", acceptedAt: row.acceptedAt, selectedModel: "unknown", lastActivityKind: "preflight",
    origin: input.origin, ownerToken: owner.token, teamOwnerToken: input.teamOwner?.token });
  setImmediate(() => {
    void (async () => {
      try {
        const prepared = await input.prepare(controller.signal, check, { instanceId: row.instanceId, dispatchId: row.dispatchId!,
          record(record) { row.consultation = record; }, current: () => liveOwner(row) && input.owns() });
        check();
        await spawnBackground({ ...prepared, reservation: row, check, foreground: controller.signal });
        ready.resolve();
        await row.run;
      } catch (error) {
        if (!row.workerStarted) {
          let failure = error;
          try { await input.cleanup?.(); } catch (cleanup) { failure = new AgentClosureError([error, cleanup], "Background preparation"); }
          row.closure = failure instanceof AgentClosureError ? { state: "unknown", reason: failure.message } : { state: "released" };
          settle(row, { instanceId: row.instanceId, role: row.roleId,
            status: controller.signal.aborted ? "cancelled" : "failed", model: { selectedModel: "unknown" },
            result: String(failure) }, observationEpoch());
        }
      } finally {
        row.preparationSettled = true;
        ready.resolve();
        completion.resolve();
        releaseNoWorker(row);
      }
    })();
  });
  return { teamId: row.teamId, memberId: row.memberId, instanceId: row.instanceId, dispatchId: row.dispatchId, roleId: row.roleId,
    status: "running", watch: false, dispatchPhase: "preflight" };
}

function releaseNoWorker(row: Row): void {
  if (row.workerStarted !== false || !row.preparationSettled || row.closure.state !== "released" ||
      row.signal !== "dropped" && !row.recipient && row.handoff?.delivery !== "incorporated") return;
  row.releaseNoWorker?.();
  row.releaseNoWorker = undefined;
}

function markConversationIdle(row: Row, epoch: number): void {
  const observation = listObservations(row.ownerToken, row.coordinatorSessionId).find(item => item.id === row.instanceId);
  if (observation) publishObservation({ ...observation, status: "running", phase: "idle", activeTool: undefined,
    teamId: row.teamId, memberId: row.memberId, turnId: row.turnId }, epoch);
}

/** Host driver only: reserve busy before startup can await. */
export async function turnTeamWorker(token: symbol, instanceId: string, task: string): Promise<AgentRunResult> {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken !== token || !liveOwner(row) || row.controller.signal.aborted || row.outcome) throw new Error("stale Team member");
  if (row.maintained?.turn || pendingTurns.has(row)) throw new Error("Team member is busy");
  pendingTurns.add(row);
  try {
    await row.ready;
    if (!liveOwner(row) || row.controller.signal.aborted || row.outcome) throw new Error("stale Team member");
    const maintained = row.maintained;
    if (!maintained || maintained.closing) throw new Error("Team member has no open conversation");
    const pending = maintained.owner.turn(task);
    maintained.turn = pending;
    try {
      const result = await pending;
      maintained.last = result;
      maintained.missingUsage ||= result.usage === undefined;
      maintained.usage = maintained.missingUsage ? undefined : mergeUsage(maintained.usage, result.usage, true);
      if (liveOwner(row) && !maintained.closing) markConversationIdle(row, observationEpoch());
      if (result.status === "cancelled") void finishTeamWorker(token, instanceId).catch(() => {});
      return result;
    } catch (error) {
      maintained.last = { instanceId, role: row.roleId, status: "failed", model: { selectedModel: "unknown" }, result: String(error) };
      void finishTeamWorker(token, instanceId).catch(() => {});
      throw error;
    } finally { maintained.turn = undefined; }
  } finally { pendingTurns.delete(row); }
}
const pendingTurns = new WeakSet<Row>();

/** Close the member's lifetime, not the exterior orchestrator that invoked this join. */
export async function finishTeamWorker(token: symbol, instanceId: string): Promise<void> {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken !== token) throw new Error("unknown Team member");
  await row.ready;
  const maintained = row.maintained;
  if (!maintained) {
    if (row.outcome) return;
    throw new Error("Team member has no maintained conversation");
  }
  if (maintained.closing) return maintained.closing;
  const completion = Promise.withResolvers<void>();
  maintained.closing = completion.promise;
  maintained.stopAbort();
  void (async () => {
    try {
      let driven: AgentRunResult | undefined;
      const closureErrors: unknown[] = [];
      if (maintained.driver) {
        try { driven = await maintained.driver; }
        catch (error) {
          if (error instanceof AgentClosureError) closureErrors.push(error);
          else driven = { instanceId, role: row.roleId, status: row.controller.signal.aborted ? "cancelled" : "failed",
            model: maintained.last?.model ?? { selectedModel: "unknown" }, result: String(error) };
        }
      }
      try { await maintained.owner.close(); } catch (error) { closureErrors.push(error); }
      // Its outcome is recorded by turnTeamWorker; a rejected turn is not unknown cleanup.
      await maintained.turn?.catch(() => {});
      if (closureErrors.length) throw new AgentClosureError(closureErrors, "Maintained Team");
      row.closure = { state: "released" };
      const result = driven ?? maintained.last ?? { instanceId, role: row.roleId, status: "cancelled" as const,
        model: { selectedModel: "unknown" }, result: "cancelled before first turn" };
      settle(row, { ...result, usage: maintained.usage,
        ...(row.controller.signal.aborted ? { status: "cancelled", result: "cancelled" } : {}) }, observationEpoch());
      completion.resolve();
    } catch (error) {
      row.closure = { state: "unknown", reason: String(error) };
      settle(row, { instanceId, role: row.roleId, status: "failed", model: { selectedModel: "unknown" }, result: String(error) }, observationEpoch());
      completion.reject(error);
    } finally { maintained.completion.resolve(); }
  })();
  return completion.promise;
}

/** Disband one container without retiring another Team under the same foreground lease. */
export async function retireTeamMembers(token: symbol, teamId: string): Promise<void> {
  const rows = [...bag().rows.values()].filter(row => row.teamOwnerToken === token && row.teamId === teamId && !row.maintained?.driver);
  // Container closure does not retire the foreground reader lease or its captures.
  for (const row of rows) if (!row.controller.signal.aborted) row.controller.abort();
  await Promise.all(rows.flatMap(row => [row.run, row.preparation]));
  const uncertain = rows.filter(row => row.closure.state !== "released");
  if (uncertain.length) throw new AgentClosureError(uncertain.map(row => new Error(`${row.instanceId}: ${
    row.closure.state === "unknown" ? row.closure.reason : "owned run has not settled"
  }`)), "Team disband");
}

export type LiveTarget = { kind: "background"; instanceId: string } | { kind: "team"; assignmentId: string };

export interface WorkerReadScope {
  coordinatorSessionId: string;
  ownerToken: symbol;
  teamToken?: symbol;
}

function currentReadRow(row: Row, epoch: number): boolean {
  const state = bag();
  return observationEpoch() === epoch && state.rows.get(row.instanceId) === row && row.signal !== "dropped" &&
    !!row.ownerToken && state.owner?.token === row.ownerToken && !!row.coordinatorSessionId &&
    (!row.teamOwnerToken || !!state.teamOwners?.has(row.teamOwnerToken));
}

function activityKey(row: Row, handle: LiveHandle): TerminalActivityKey {
  return { ownerToken: row.ownerToken!, coordinatorSessionId: row.coordinatorSessionId!,
    teamOwnerToken: row.teamOwnerToken, assignmentId: row.teamAssignmentId, instanceId: row.instanceId,
    generation: row.generation, attemptId: row.attemptId!, historyId: handle.historyId, sessionId: handle.sessionId };
}

/** Borrow the handle only for this synchronous read; terminal reads retain plain identity, never the handle. */
export function resolveWorkerReadBinding(target: LiveTarget, scope: WorkerReadScope) {
  const state = bag();
  if (!scope.ownerToken || !scope.coordinatorSessionId || state.owner?.token !== scope.ownerToken ||
      target.kind === "team" && (!scope.teamToken || !state.teamOwners?.has(scope.teamToken)))
    throw new Error("stale_owner");
  const row = target.kind === "background" ? state.rows.get(target.instanceId)
    : [...state.rows.values()].find(item => item.teamAssignmentId === target.assignmentId && item.teamOwnerToken === scope.teamToken);
  if (!row || row.signal === "dropped" || row.ownerToken !== scope.ownerToken ||
      row.coordinatorSessionId !== scope.coordinatorSessionId || target.kind === "background" && row.teamOwnerToken)
    throw new Error("unknown_target");
  const key = terminalActivityKey(row.instanceId, scope.ownerToken, scope.coordinatorSessionId,
    target.kind === "team" ? scope.teamToken : undefined);
  return { instanceId: row.instanceId, generation: row.generation, attemptId: row.attemptId,
    key, handle: row.live, conversation: row.conversation };
}

export interface ResultTextPage {
  text: string;
  offset: number;
  nextOffset: number | null;
}

export interface WorkerResultOptions {
  offset?: number;
  metadataOffset?: number;
}

export type WorkerResultRead =
  | { state: "ready"; instanceId: string; generation: number; status: AgentRunResult["status"];
      text: ResultTextPage; metadata: ResultTextPage }
  | { state: "pending"; instanceId: string; generation: number }
  | { state: "unavailable"; reason: "unknown_target" | "outcome_missing" | "unsupported_kind" }
  | { state: "stale_owner" }
  | { state: "invalid_cursor" };

/** Inspect the authoritative outcome without consuming it or admitting native input. */
export function readWorkerResult(target: LiveTarget, scope: WorkerReadScope, options: WorkerResultOptions = {}): WorkerResultRead {
  const state = bag();
  if (!scope.ownerToken || !scope.coordinatorSessionId || state.owner?.token !== scope.ownerToken) {
    return { state: "stale_owner" };
  }
  if (target.kind !== "background" && target.kind !== "team") {
    return { state: "unavailable", reason: "unsupported_kind" };
  }
  if (target.kind === "team" && (!scope.teamToken || !state.teamOwners?.has(scope.teamToken))) {
    return { state: "stale_owner" };
  }
  const row = target.kind === "background" ? state.rows.get(target.instanceId)
    : [...state.rows.values()].find(item => item.teamAssignmentId === target.assignmentId && item.teamOwnerToken === scope.teamToken);
  if (!row) return { state: "unavailable", reason: "unknown_target" };
  // Foreign or incompletely scoped rows are indistinguishable from absent targets.
  if (row.ownerToken !== scope.ownerToken || row.coordinatorSessionId !== scope.coordinatorSessionId) {
    return { state: "unavailable", reason: "unknown_target" };
  }
  if (target.kind === "background" && row.teamOwnerToken) return { state: "unavailable", reason: "unknown_target" };
  if (!row.outcome) {
    return row.signal === "pending" && statusOf(row) === "running"
      ? { state: "pending", instanceId: row.instanceId, generation: row.generation }
      : { state: "unavailable", reason: "outcome_missing" };
  }
  const { result, requests: _requests, ...metadata } = row.outcome;
  const text = resultTextPage(result, options.offset ?? 0);
  const metadataPage = resultTextPage(JSON.stringify(metadata), options.metadataOffset ?? 0);
  if (!text || !metadataPage) return { state: "invalid_cursor" };
  return {
    state: "ready", instanceId: row.instanceId, generation: row.generation, status: row.outcome.status,
    text, metadata: metadataPage,
  };
}

function resultTextPage(value: string, offset: number): ResultTextPage | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) return undefined;
  const text = value.slice(offset, offset + 1024);
  const end = offset + text.length;
  return { text, offset, nextOffset: end < value.length ? end : null };
}

/** Resolve admission from the row and current foreground generation, never a role. */
export function resolveLiveTarget(target: LiveTarget, coordinatorSessionId: string | undefined, teamToken?: symbol): LiveHandle {
  return resolveLiveBinding(target, coordinatorSessionId, teamToken).handle;
}

export function resolveLiveBinding(target: LiveTarget, coordinatorSessionId: string | undefined, teamToken?: symbol): {
  handle: LiveHandle; instanceId: string; generation: number;
} {
  const state = bag();
  const row = target.kind === "background" ? state.rows.get(target.instanceId)
    : [...state.rows.values()].find(item => item.teamAssignmentId === target.assignmentId && item.teamOwnerToken === teamToken);
  if (!row || (target.kind === "background" && row.teamOwnerToken)) throw new Error("unknown live target");
  if (!coordinatorSessionId || row.coordinatorSessionId !== coordinatorSessionId || !row.ownerToken || state.owner?.token !== row.ownerToken) {
    throw new Error("live target belongs to a different foreground owner");
  }
  if (target.kind === "team" && (!teamToken || row.teamOwnerToken !== teamToken || !state.teamOwners?.has(teamToken))) {
    throw new Error("Team evaluation is retired");
  }
  if (statusOf(row) !== "running" || row.signal === "dropped") throw new Error("live target is terminal");
  if (!row.live) throw new Error("live target has no native session binding");
  return { handle: row.live, instanceId: row.instanceId, generation: row.generation };
}

export function workerStatus(instanceId?: string, now: () => number = Date.now): WorkerView[] {
  const rows = [...bag().rows.values()].filter((row) => !row.teamOwnerToken);
  const matched = instanceId ? rows.filter((row) => row.instanceId === instanceId) : rows;
  if (instanceId && matched.length === 0) throw new Error(`unknown worker ${instanceId}`);
  return matched.map((row) => view(row, now()));
}

export function workerResult(instanceId: string): AgentRunResult {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken) throw new Error(`unknown worker ${instanceId}`);
  if (!row.outcome) {
    throw new Error(statusOf(row) === "running" ? "worker is still running" : "result is not available");
  }
  const outcome = row.outcome;
  collectResult(row);
  return outcome;
}

export function cancelWorker(instanceId: string, now: () => number = Date.now): WorkerView {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken) throw new Error(`unknown worker ${instanceId}`);
  if (!row.outcome && !row.controller.signal.aborted) row.controller.abort();
  return view(row, now());
}

export function teamWorkerStatus(token: symbol, instanceId?: string, now: () => number = Date.now): WorkerView[] {
  const rows = [...bag().rows.values()].filter((row) => row.teamOwnerToken === token);
  const matched = instanceId ? rows.filter((row) => row.instanceId === instanceId) : rows;
  if (instanceId && matched.length === 0) throw new Error(`unknown Team worker ${instanceId}`);
  return matched.map((row) => view(row, now()));
}

export function teamWorkerResult(token: symbol, instanceId: string): AgentRunResult {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken !== token) throw new Error(`unknown Team worker ${instanceId}`);
  if (!row.outcome) throw new Error(statusOf(row) === "running" ? "worker is still running" : "result is not available");
  collectResult(row);
  return row.outcome;
}

export function cancelTeamWorker(token: symbol, instanceId: string, now: () => number = Date.now): WorkerView {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken !== token) throw new Error(`unknown Team worker ${instanceId}`);
  if (!row.outcome && !row.controller.signal.aborted) row.controller.abort();
  return view(row, now());
}

/** Retire only rows and observations attached to this evaluation lease. */
export async function retireTeamWorkers(token: symbol): Promise<void> {
  const state = bag();
  state.teamOwners?.delete(token);
  await retireRows([...state.rows.values()].filter(row => row.teamOwnerToken === token));
  removeTeamObservations(token);
}

async function retireRows(rows: Row[]): Promise<void> {
  const state = bag();
  for (const row of rows) {
    row.signal = "dropped";
    row.conversation?.retire();
    if (!row.controller.signal.aborted) row.controller.abort();
  }
  await Promise.all(rows.flatMap(row => [row.run, row.preparation]));
  const uncertain = rows.filter(row => row.closure.state !== "released");
  for (const row of rows) {
    if (row.closure.state !== "released" || state.rows.get(row.instanceId) !== row) continue;
    if (row.consultation) {
      row.consultation.retired();
      row.consultation.settled();
    }
    releaseNoWorker(row);
    row.onTeamSettled?.(row.outcome?.status ?? "cancelled");
    state.rows.delete(row.instanceId);
    removeObservation(row.instanceId);
  }
  if (uncertain.length) throw new AgentClosureError(uncertain.map(row => new Error(`${row.instanceId}: ${
    row.closure.state === "unknown" ? row.closure.reason : "owned run has not settled"
  }`)), "Background retirement");
}

export async function cancelAllWorkers(): Promise<void> {
  const state = bag();
  await retireRows([...state.rows.values()]);
  state.restrictions.clear();
  clearObservations();
}

export async function shutdownBackground(token: symbol): Promise<void> {
  const state = bag();
  state.teamOwners?.delete(token);
  if (state.owner?.token === token) state.owner = undefined;
  await retireRows([...state.rows.values()].filter(row => row.ownerToken === token));
  state.restrictions.delete(token);
  removeTeamObservations(token);
}

export function formatWorkerHandle(handle: WorkerHandle): string {
  return [
    ...(handle.teamId ? [`team_id: ${handle.teamId}`, `member_id: ${handle.memberId}`] : []),
    `instance_id: ${handle.instanceId}`,
    ...(handle.dispatchId ? [`dispatch_id: ${handle.dispatchId}`, `dispatch_phase: ${handle.dispatchPhase}`] : []),
    `role: ${handle.roleId}`,
    `status: ${handle.status}`,
    `watch: ${handle.watch ? "yes" : "no"}`,
  ].join("\n");
}

export function formatWorkerViews(views: WorkerView[]): string {
  if (views.length === 0) return "no workers";
  return views
    .map((item) =>
      [
        `instance_id: ${item.instanceId}`,
        `role: ${item.roleId}`,
        `status: ${item.status}`,
        `watch: ${item.watch ? "yes" : "no"}`,
        `elapsed_ms: ${item.elapsedMs}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function interestFrom(plan: string | undefined, unit: string | undefined): WorkerInterest | undefined {
  const planId = plan?.trim() ?? "";
  const unitId = unit?.trim() ?? "";
  if (planId.length === 0 && unitId.length === 0) return undefined;
  if (planId.length === 0 || unitId.length === 0) {
    throw new PitakoConfigError("agent_spawn plan and unit must both be set");
  }
  return { planId, unitId };
}

function settle(row: Row, result: AgentRunResult, epoch: number): void {
  const state = bag();
  const current = state.rows.get(row.instanceId);
  if (current !== row) return;
  current.outcome = result;
  current.dispatchPhase = "settled";
  current.consultation?.event("outcome", current.workerStarted
    ? { workerStarted: true, status: result.status, instanceId: result.instanceId, model: result.model, usage: result.usage }
    : { workerStarted: false, status: result.status, reason: result.result });
  current.consultation?.settled(current.closure.state === "unknown" ? current.closure.reason : undefined);
  if (current.workerStarted !== false && current.closure.state === "released" && current.signal !== "dropped" && liveOwner(current)) current.onTeamSettled?.(result.status);
  current.recipient?.settle(result, current.closure);
  current.conversation?.finish();
  if (current.maintained && currentReadRow(current, epoch)) {
    const observation = listObservations(current.ownerToken, current.coordinatorSessionId).find(item => item.id === current.instanceId);
    if (observation) publishObservation({ ...observation, status: result.status, phase: "idle", terminalAt: Date.now(), agentUsage: result.usage }, epoch);
  }
  if (current.signal === "dropped") return;
  if (current.workerStarted === false) publishObservation({ id: current.instanceId, roleId: current.roleId, task: current.launch?.task ?? "",
    status: result.status, phase: "idle", acceptedAt: current.acceptedAt, selectedModel: "unknown", lastActivityKind: "no-worker",
    ownerToken: current.ownerToken, teamOwnerToken: current.teamOwnerToken,
    origin: current.launch?.origin }, epoch);
  if (currentReadRow(current, epoch)) touchObservation(current.instanceId, epoch);
  collectResult(current);
  if (liveOwner(current) && idleOf(current.deliveryOwner)) deliverWorkerResults(current.ownerToken!);
}

function idleOf(owner: BackgroundOwner | undefined): boolean {
  if (!owner) return false;
  try {
    return owner.isIdle();
  } catch {
    return false;
  }
}

function liveOwner(row: Row): boolean {
  const owner = row.deliveryOwner;
  return bag().rows.get(row.instanceId) === row && row.signal !== "dropped" && !!owner &&
    owner.token === row.ownerToken &&
    (row.teamOwnerToken ? bag().teamOwners?.get(row.teamOwnerToken) === owner : bag().owner === owner) &&
    (!owner.owns || owner.owns());
}

function collectResult(row: Row): void {
  if (!row.outcome || row.recipient || row.handoff || !liveOwner(row)) return;
  // A protocol driver cannot hand off while an owned member's closure is unknown.
  if (row.maintained?.driver && row.closure.state !== "released") return;
  const owner = row.deliveryOwner!;
  const details = Object.freeze({
    teamId: row.teamId, memberId: row.memberId, turnId: row.turnId,
    deliveryId: randomUUID(), instanceId: row.instanceId, assignmentId: row.teamAssignmentId,
    ownerSessionId: owner.sessionId ?? row.coordinatorSessionId, foregroundRevision: owner.revision,
    status: row.outcome.status,
    ...(row.dispatchId ? { dispatchId: row.dispatchId, workerStarted: row.workerStarted } : {}),
    roleId: row.roleId, planId: row.interest?.planId, unitId: row.interest?.unitId,
  });
  row.handoff = {
    message: Object.freeze({ customType: "pitako.worker.result", content: row.outcome.result, display: true, details }),
    collection: "collected", bookkeeping: row.reconcileBookkeeping ? "pending" : "inapplicable",
    delivery: "pending", continuation: "not-requested",
    bookkeepingAttempts: 0, deliveryAttempts: 0, wakeAttempts: 0, outstanding: false, busyContinuation: false,
  };
  reconcileBookkeeping(row);
  publishHandoff(row);
}

function reconcileBookkeeping(row: Row): void {
  const handoff = row.handoff!;
  if (!liveOwner(row) || !row.reconcileBookkeeping || handoff.bookkeeping === "reconciled" ||
      handoff.bookkeepingAttempts >= 2) return;
  ++handoff.bookkeepingAttempts;
  try {
    row.reconcileBookkeeping(row.outcome!);
    if (!liveOwner(row)) return;
    handoff.bookkeeping = "reconciled";
    handoff.bookkeepingDiagnostic = undefined;
  } catch (error) {
    if (!liveOwner(row)) return;
    handoff.bookkeeping = "blocked";
    handoff.bookkeepingDiagnostic = String(error);
  }
}

export function workerHandoff(instanceId: string): WorkerHandoff | undefined {
  const handoff = bag().rows.get(instanceId)?.handoff;
  if (!handoff) return undefined;
  const { message: _message, bookkeepingAttempts: _b, deliveryAttempts: _d, wakeAttempts: _w,
    outstanding: _o, busyContinuation: _c, ...view } = handoff;
  return view;
}

function publishHandoff(row: Row): void {
  if (!liveOwner(row)) return;
  const handoff = row.handoff!;
  noteHandoff(row.instanceId, workerHandoff(row.instanceId)!);
  if (liveOwner(row) && handoff.delivery === "incorporated" && handoff.continuation === "observed" &&
      (handoff.bookkeeping === "reconciled" || handoff.bookkeeping === "inapplicable")) noteResultTaken(row.instanceId);
}

function ownerRows(token: symbol): Row[] {
  return [...bag().rows.values()].filter(row => row.ownerToken === token && row.handoff && liveOwner(row));
}

/** Only committed entries in the captured owner's active branch are receipts. */
function incorporated(row: Row): boolean {
  if (!liveOwner(row)) return false;
  const message = row.handoff!.message;
  try {
    const matches = receiptInBranch(message, row.deliveryOwner!.getBranch?.() ?? []);
    return matches && liveOwner(row);
  } catch { return false; }
}

export function observeWorkerResults(token: symbol, turnStarted = false): void {
  for (const row of ownerRows(token)) {
    const handoff = row.handoff!;
    const inBranch = incorporated(row);
    if (inBranch) {
      if (handoff.delivery !== "incorporated") row.consultation?.event("delivery", { state: "incorporated", deliveryId: handoff.message.details.deliveryId });
      handoff.delivery = "incorporated";
      releaseNoWorker(row);
      handoff.deliveryDiagnostic = undefined;
      handoff.outstanding = false;
      if (turnStarted) {
        handoff.continuation = "observed";
        handoff.continuationDiagnostic = undefined;
      }
    }
    publishHandoff(row);
  }
}

export function restrictWorkerContinuation(token: symbol, outcome: "completed" | "aborted" | "error"): void {
  if (outcome === "completed") return;
  bag().restrictions.set(token, outcome);
  for (const row of ownerRows(token)) {
    if (row.handoff!.continuation === "observed") continue;
    row.handoff!.continuation = "blocked-unconfirmed";
    row.handoff!.continuationDiagnostic = `parent ${outcome}`;
    publishHandoff(row);
  }
}

/** Only an externally initiated run clears abort/error restrictions. Native wakes bypass this hook. */
export function externallyStartedWorkerOwner(token: symbol): void {
  bag().restrictions.delete(token);
}

function canOffer(row: Row): boolean {
  const handoff = row.handoff!;
  return liveOwner(row) && handoff.delivery !== "incorporated" && !handoff.outstanding && handoff.deliveryAttempts < 2;
}

function offer(row: Row): ResultMessage {
  const handoff = row.handoff!;
  return offerEnvelope(handoff, handoff.message);
}

/** Busy boundary: drafts are offers, never receipts, regardless of preview canContinue. */
export function draftWorkerResults(token: symbol, outcome: "completed" | "aborted" | "error") {
  observeWorkerResults(token);
  restrictWorkerContinuation(token, outcome);
  const entries: (ResultMessage & { type: "custom_message" })[] = [];
  for (const row of ownerRows(token)) {
    reconcileBookkeeping(row);
    if (canOffer(row)) {
      entries.push({ type: "custom_message", ...offer(row) });
      if (outcome === "completed" && !bag().restrictions.has(token)) {
        row.handoff!.continuation = "requested";
        row.handoff!.busyContinuation = true;
      }
    }
    publishHandoff(row);
  }
  return entries.length ? { entries, continue: outcome === "completed" && !bag().restrictions.has(token) } : undefined;
}

/** One append per complete result, then a single short wake for the incorporated batch. */
export function deliverWorkerResults(token: symbol, terminalOperation = false, recovery = false): void {
  observeWorkerResults(token);
  const rows = ownerRows(token);
  const wakes: Row[] = [];
  for (const row of rows) {
    if (!terminalOperation && !idleOf(row.deliveryOwner)) continue;
    if (recovery) reconcileBookkeeping(row);
    const handoff = row.handoff!;
    if (canOffer(row)) {
      const message = offer(row);
      try {
        if (!row.deliveryOwner!.appendResult) throw new Error("result append boundary unavailable");
        row.deliveryOwner!.appendResult(message);
      } catch (error) {
        if (!liveOwner(row)) continue;
        handoff.outstanding = false;
        handoff.delivery = "blocked";
        handoff.deliveryDiagnostic = String(error);
      }
      if (!liveOwner(row)) continue;
      observeWorkerResults(token);
    }
    if (bag().restrictions.has(token)) {
      restrictWorkerContinuation(token, bag().restrictions.get(token)!);
    } else if (handoff.delivery === "incorporated" && !handoff.busyContinuation &&
        handoff.continuation !== "observed" && handoff.wakeAttempts < 2 &&
        (handoff.wakeAttempts === 0 || recovery)) {
      ++handoff.wakeAttempts;
      handoff.continuation = "requested";
      handoff.continuationDiagnostic = "owning turn not yet observed";
      wakes.push(row);
    }
    publishHandoff(row);
  }
  if (!wakes.length || !liveOwner(wakes[0]!)) return;
  try {
    wakes[0]!.deliveryOwner!.sendMessage("Interpret the complete Pitako worker results already supplied in context. Decide the next authorized work; no result fetch or acknowledgement is required.");
  } catch (error) {
    for (const row of wakes) {
      if (!liveOwner(row)) continue;
      row.handoff!.continuation = "blocked-unconfirmed";
      row.handoff!.continuationDiagnostic = String(error);
      publishHandoff(row);
    }
  }
}

/** Final boundaries settle outstanding drafts; they never bypass a rejected busy continuation. */
export function settleWorkerResults(token: symbol, terminalOperation = false, finalAgentSettlement = true): void {
  observeWorkerResults(token);
  const outstanding = new Set<Row>();
  for (const row of ownerRows(token)) {
    const handoff = row.handoff!;
    if (handoff.outstanding) {
      outstanding.add(row);
      handoff.outstanding = false;
      if (handoff.deliveryAttempts >= 2) handoff.delivery = "blocked";
      handoff.deliveryDiagnostic = "commitment unconfirmed at final boundary";
    }
    if (finalAgentSettlement && handoff.busyContinuation && handoff.continuation === "requested") {
      handoff.continuation = "blocked-unconfirmed";
      handoff.continuationDiagnostic = "busy continuation ended without an observed owning turn";
    }
    publishHandoff(row);
  }
  // Do not retry an unresolved offer in the same callback that closes it.
  for (const row of outstanding) row.handoff!.outstanding = true;
  deliverWorkerResults(token, terminalOperation, true);
  for (const row of outstanding) {
    if (liveOwner(row)) row.handoff!.outstanding = false;
  }
}

export function teamWorkerHasOutcome(token: symbol, instanceId: string): boolean {
  const row = bag().rows.get(instanceId);
  return row?.teamOwnerToken === token && row.outcome !== undefined;
}

function statusOf(row: Row): WorkerStatus {
  if (row.outcome) return row.outcome.status;
  if (row.controller.signal.aborted) return "cancelled";
  return "running";
}

function view(row: Row, now: number): WorkerView {
  return {
    teamId: row.teamId, memberId: row.memberId, turnId: row.turnId,
    instanceId: row.instanceId,
    roleId: row.roleId,
    status: statusOf(row),
    watch: row.interest !== undefined,
    elapsedMs: Math.max(0, now - row.acceptedAt),
    closure: { ...row.closure },
    dispatchId: row.dispatchId, dispatchPhase: row.dispatchPhase, workerStarted: row.workerStarted,
  };
}

/** Exact active-branch receipt, rechecked synchronously by the captured native writer. */
export function consultationFeedback(input: import("./consultation-feedback.ts").ConsultationFeedbackInput, sessionId: string | undefined, manager: unknown) {
  const row = [...bag().rows.values()].find(row => row.dispatchId === input.dispatchId && row.coordinatorSessionId === sessionId);
  if (!row?.consultation || !row.consultation.matchesCaller(manager) || !row.handoff || !liveOwner(row) || row.closure.state !== "released")
    throw new Error("consultation is not owned and physically settled");
  return row.consultation.feedback(input, () => incorporated(row));
}

/** Nonterminal response channel: no outcome, handoff, hold, occupancy or resultTaken effects. */
export function publishIntermediate(token: symbol, instanceId: string, roomId: string, turnId: string, content: string): void {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken !== token || !liveOwner(row) || row.outcome || row.controller.signal.aborted || row.recipient)
    throw new Error("intermediate owner retired");
  row.intermediates ??= [];
  if (row.intermediates.some(item => item.message.details.turnId === turnId)) throw new Error("duplicate intermediate turn");
  row.intermediates.push({ message: { customType: "pitako.architecture.response", content, display: true,
    details: { deliveryId: randomUUID(), roomId, assignmentId: row.teamAssignmentId!, instanceId, turnId } },
    delivery: "pending", continuation: "not-requested", deliveryAttempts: 0, wakeAttempts: 0, outstanding: false, busyContinuation: false });
  if (idleOf(row.deliveryOwner)) deliverIntermediateResults(token);
}
function intermediateRows(token: symbol) {
  return [...bag().rows.values()].filter(row => row.ownerToken === token && row.intermediates && liveOwner(row));
}
export function intermediateReceipts(token: symbol, instanceId: string) {
  const row = bag().rows.get(instanceId);
  if (!row || row.ownerToken !== token || !liveOwner(row)) return [];
  return row.intermediates?.map(item => ({ ...item.message.details, delivery: item.delivery, continuation: item.continuation,
    diagnostic: item.deliveryDiagnostic })) ?? [];
}
export function observeIntermediateResults(token: symbol, turnStarted = false): void {
  for (const row of intermediateRows(token)) for (const item of row.intermediates!) {
    try {
      if (receiptInBranch(item.message, row.deliveryOwner!.getBranch?.() ?? []) && liveOwner(row)) {
        item.delivery = "incorporated"; item.outstanding = false; item.deliveryDiagnostic = undefined;
        if (turnStarted) item.continuation = "observed";
      }
    } catch (error) { item.deliveryDiagnostic = `receipt unavailable: ${String(error)}`; }
    if (bag().restrictions.has(token) && item.continuation !== "observed") item.continuation = "blocked-unconfirmed";
  }
}
export function draftIntermediateResults(token: symbol, outcome: "completed" | "aborted" | "error") {
  observeIntermediateResults(token);
  const entries: (IntermediateMessage & { type: "custom_message" })[] = [];
  for (const row of intermediateRows(token)) for (const item of row.intermediates!) {
    if (item.delivery !== "incorporated" && !item.outstanding && item.deliveryAttempts < 2) {
      entries.push({ type: "custom_message", ...offerEnvelope(item, item.message) });
      if (outcome === "completed" && !bag().restrictions.has(token)) { item.continuation = "requested"; item.busyContinuation = true; }
    }
  }
  return entries.length ? { entries, continue: outcome === "completed" && !bag().restrictions.has(token) } : undefined;
}
export function deliverIntermediateResults(token: symbol, terminalOperation = false, recovery = false): void {
  observeIntermediateResults(token);
  let wake: Row | undefined;
  for (const row of intermediateRows(token)) {
    if (!terminalOperation && !idleOf(row.deliveryOwner)) continue;
    for (const item of row.intermediates!) {
      if (item.delivery !== "incorporated" && !item.outstanding && item.deliveryAttempts < 2) {
        try {
          const message = offerEnvelope(item, item.message);
          if (!row.deliveryOwner!.appendIntermediate) throw new Error("intermediate append boundary unavailable");
          row.deliveryOwner!.appendIntermediate(message);
        } catch (error) { item.outstanding = false; item.delivery = "blocked"; item.deliveryDiagnostic = String(error); }
        observeIntermediateResults(token);
      }
      if (!liveOwner(row) || bag().restrictions.has(token)) continue;
      if (item.delivery === "incorporated" && !item.busyContinuation && item.continuation !== "observed" &&
          item.wakeAttempts < 2 && (!item.wakeAttempts || recovery)) {
        ++item.wakeAttempts; item.continuation = "requested"; wake = row;
      }
    }
  }
  if (wake && liveOwner(wake)) {
    try { wake.deliveryOwner!.sendMessage("Interpret the architecture responses already supplied. Continue authorized work; no polling or acknowledgement required."); }
    catch { for (const item of wake.intermediates!) if (item.continuation === "requested") item.continuation = "blocked-unconfirmed"; }
  }
}
export function settleIntermediateResults(token: symbol, terminalOperation = false, final = true): void {
  observeIntermediateResults(token);
  const outstanding: Intermediate[] = [];
  for (const row of intermediateRows(token)) for (const item of row.intermediates!) {
    if (item.outstanding) { outstanding.push(item); item.deliveryDiagnostic = "commitment unconfirmed at final boundary"; }
    if (final && item.busyContinuation && item.continuation === "requested") item.continuation = "blocked-unconfirmed";
  }
  deliverIntermediateResults(token, terminalOperation, true);
  for (const item of outstanding) { item.outstanding = false; if (item.deliveryAttempts >= 2) item.delivery = "blocked"; }
}
