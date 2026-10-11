import { PitakoConfigError } from "../errors.ts";
import { createPiExecutor } from "./pi.ts";
import { clearObservations, noteResultTaken, observationEpoch, publishObservation, removeObservation, removeTeamObservations,
  publishActivityBinding, retainTerminalActivity, noteTerminalActivityUnavailable, terminalActivityKey,
  removeOwnerTerminalActivity, touchObservation, type TerminalActivityKey } from "./observe.ts";
import { runAgentInstance, type AgentRunResult, type AttemptExecutor } from "./run.ts";
import type { LoadOptions } from "../roles/load.ts";
import type { ExecutionBinding } from "../workflow.ts";
import type { LiveHandle } from "./live.ts";

export interface WorkerInterest {
  planId: string;
  unitId: string;
  execution?: ExecutionBinding;
}

export interface WorkerHandle {
  instanceId: string;
  roleId: string;
  status: "running";
  watch: boolean;
}

export type WorkerStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkerView {
  instanceId: string;
  roleId: string;
  status: WorkerStatus;
  watch: boolean;
  elapsedMs: number;
}

export interface BackgroundOwner {
  token: symbol;
  isIdle: () => boolean;
  hasUI: boolean;
  notify: (message: string) => void;
  sendMessage: (content: string) => void;
}

type SignalState = "pending" | "held" | "sent" | "dropped";

interface Row {
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
  teamDeliveryOwner?: BackgroundOwner;
  ownerToken?: symbol;
  coordinatorSessionId?: string;
  live?: LiveHandle;
  generation: number;
  attemptId?: string;
}

interface Bag {
  rows: Map<string, Row>;
  owner?: BackgroundOwner;
  teamOwners?: Map<symbol, BackgroundOwner>;
  held: { ownerToken?: symbol; instanceId: string; text: string; owner?: BackgroundOwner }[];
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
  const created: Bag = { rows: new Map(), held: [], teamOwners: new Map() };
  host[KEY] = created;
  return created;
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

export function deliveryFor(watch: boolean, idle: boolean): "notify" | "wake" | "hold" {
  if (!watch) return "notify";
  return idle ? "wake" : "hold";
}

export function completionText(input: {
  instanceId: string;
  roleId: string;
  status: WorkerStatus;
  interest?: WorkerInterest;
  channel: "notify" | "wake";
  teamAssignmentId?: string;
}): string {
  const base = input.teamAssignmentId
    ? `Pitako Team assignment ${input.teamAssignmentId} ${input.status} role ${input.roleId} (instance ${input.instanceId}).`
    : `Pitako worker ${input.instanceId} ${input.status} role ${input.roleId}.`;
  if (input.channel === "notify" || !input.interest) return base;
  return `${base.slice(0, -1)} plan ${input.interest.planId} unit ${input.interest.unitId}. Use ${input.teamAssignmentId ? "team_result" : "agent_result"}. Do not do this role's work.`;
}

export async function spawnBackground(input: {
  roleId: string;
  task: string;
  cwd: string;
  historyOrigin?: import("./history.ts").HistoryOrigin;
  dispatch?: import("./routing.ts").DispatchSnapshot;
  foreground?: AbortSignal;
  watch?: WorkerInterest;
  executor: AttemptExecutor;
  load?: LoadOptions;
  now?: () => number;
  teamOwner?: { token: symbol; assignmentId: string; onSettled: (status: WorkerStatus) => void };
}): Promise<WorkerHandle> {
  if (input.foreground?.aborted) throw new Error("agent_spawn cancelled");
  const controller = new AbortController();
  const now = input.now ?? Date.now;
  const epoch = observationEpoch();
  const ownerToken = bag().owner?.token;
  let row: Row | undefined;
  const pending = runAgentInstance({
    roleId: input.roleId,
    task: input.task,
    cwd: input.cwd,
    executionRoot: input.watch?.execution?.executionRoot,
    historyOrigin: input.historyOrigin,
    dispatch: input.dispatch,
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
      if (input.foreground?.aborted) throw new Error("agent_spawn cancelled");
      row = {
        instanceId: instance.id,
        roleId: instance.roleId,
        acceptedAt: now(),
        interest: input.watch,
        controller,
        signal: "pending",
        teamOwnerToken: input.teamOwner?.token,
        teamAssignmentId: input.teamOwner?.assignmentId,
        onTeamSettled: input.teamOwner?.onSettled,
        teamDeliveryOwner: input.teamOwner ? bag().teamOwners?.get(input.teamOwner.token) : undefined,
        ownerToken,
        coordinatorSessionId: input.historyOrigin?.coordinatorSessionId,
        generation: 0,
      };
      bag().rows.set(instance.id, row);
    },
    onObserve(snapshot) {
      if (!row || bag().rows.get(row.instanceId) !== row || row.signal === "dropped" ||
          epoch !== observationEpoch() || row.ownerToken && bag().owner?.token !== row.ownerToken ||
          row.teamOwnerToken && !bag().teamOwners?.has(row.teamOwnerToken)) return;
      row.attemptId = snapshot.attemptId;
      publishObservation(
        {
          ...snapshot,
          planId: input.watch?.planId,
          unitId: input.watch?.unitId,
          teamOwnerToken: input.teamOwner?.token,
          ownerToken,
        },
        epoch,
      );
      if (row.live && row.attemptId && currentReadRow(row, epoch)) publishActivityBinding(activityKey(row, row.live), epoch);
    },
  });
  if (!row) {
    await pending;
    throw new Error("agent_spawn did not accept");
  }
  const accepted = row;
  pending.then(
    (result) => settle(accepted, result, epoch),
    (error: unknown) =>
      settle(accepted, {
        instanceId: accepted.instanceId,
        role: accepted.roleId,
        status: "failed",
        model: { selectedModel: "unknown" },
        result: error instanceof Error ? error.message : String(error),
      }, epoch),
  );
  return {
    instanceId: accepted.instanceId,
    roleId: accepted.roleId,
    status: "running",
    watch: accepted.interest !== undefined,
  };
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
    key, handle: row.live };
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
  noteResultTaken(instanceId);
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
  noteResultTaken(instanceId);
  return row.outcome;
}

export function cancelTeamWorker(token: symbol, instanceId: string, now: () => number = Date.now): WorkerView {
  const row = bag().rows.get(instanceId);
  if (!row || row.teamOwnerToken !== token) throw new Error(`unknown Team worker ${instanceId}`);
  if (!row.outcome && !row.controller.signal.aborted) row.controller.abort();
  return view(row, now());
}

/** Retire only rows and observations attached to this evaluation lease. */
export function retireTeamWorkers(token: symbol): void {
  const state = bag();
  state.teamOwners?.delete(token);
  for (const [id, row] of state.rows) {
    if (row.teamOwnerToken !== token) continue;
    row.signal = "dropped";
    if (!row.controller.signal.aborted) row.controller.abort();
    state.rows.delete(id);
    removeObservation(id);
  }
  removeTeamObservations(token);
}

export function cancelAllWorkers(): void {
  const state = bag();
  for (const row of state.rows.values()) {
    row.signal = "dropped";
    if (!row.controller.signal.aborted) row.controller.abort();
  }
  state.rows.clear();
  state.held = [];
  clearObservations();
}

export function shutdownBackground(token: symbol): void {
  const state = bag();
  for (const [id, row] of state.rows) {
    if (row.ownerToken !== token) continue;
    row.signal = "dropped";
    if (!row.controller.signal.aborted) row.controller.abort();
    state.rows.delete(id);
    removeObservation(id);
  }
  state.held = state.held.filter((item) => item.ownerToken !== token);
  state.teamOwners?.delete(token);
  removeTeamObservations(token);
  if (state.owner?.token === token) state.owner = undefined;
}

export function takeHeldCompletions(token: symbol): string | undefined {
  const state = bag();
  if (state.held.length === 0) return undefined;
  const held = state.held.filter((item) => item.ownerToken === token);
  const owner = held[0]?.owner;
  if (held.length === 0 || !owner || !idleOf(owner)) return undefined;
  state.held = state.held.filter((item) => item.ownerToken !== token);
  for (const item of held) {
    const row = state.rows.get(item.instanceId);
    if (row?.signal === "held") row.signal = "sent";
  }
  return held.map((item) => item.text).join("\n");
}

export function formatWorkerHandle(handle: WorkerHandle): string {
  return [
    `instance_id: ${handle.instanceId}`,
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
  if (current !== row || current.signal === "dropped" || current.signal === "sent") return;
  current.outcome = result;
  current.onTeamSettled?.(result.status);
  if (currentReadRow(current, epoch)) touchObservation(current.instanceId, epoch);
  if (current.teamOwnerToken && current.teamDeliveryOwner?.token !== current.teamOwnerToken) {
    current.signal = "dropped";
    return;
  }
  const deliveryOwner = current.teamOwnerToken ? current.teamDeliveryOwner : state.owner;
  const channel = deliveryFor(current.interest !== undefined, idleOf(deliveryOwner));
  const text = completionText({
    instanceId: current.instanceId,
    roleId: current.roleId,
    status: result.status,
    interest: current.interest,
    channel: channel === "hold" ? "wake" : channel,
    teamAssignmentId: current.teamAssignmentId,
  });
  if (channel === "hold") {
    current.signal = "held";
    state.held.push({ ownerToken: current.teamOwnerToken ?? state.owner?.token, instanceId: current.instanceId, text, owner: deliveryOwner });
    return;
  }
  current.signal = "sent";
  if (channel === "notify") {
    if (deliveryOwner?.hasUI) deliveryOwner.notify(text);
    return;
  }
  deliveryOwner?.sendMessage(text);
}

function idleOf(owner: BackgroundOwner | undefined): boolean {
  if (!owner) return false;
  try {
    return owner.isIdle();
  } catch {
    return false;
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
    instanceId: row.instanceId,
    roleId: row.roleId,
    status: statusOf(row),
    watch: row.interest !== undefined,
    elapsedMs: Math.max(0, now - row.acceptedAt),
  };
}
