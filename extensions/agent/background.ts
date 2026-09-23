import { PitakoConfigError } from "../errors.ts";
import { createPiExecutor } from "./pi.ts";
import { clearObservations, noteResultTaken, observationEpoch, publishObservation, removeTeamObservations, removeUntaggedObservations } from "./observe.ts";
import { runAgentInstance, type AgentRunResult, type AttemptExecutor } from "./run.ts";
import type { LoadOptions } from "../roles/load.ts";

export interface WorkerInterest {
  planId: string;
  unitId: string;
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
  let row: Row | undefined;
  const pending = runAgentInstance({
    roleId: input.roleId,
    task: input.task,
    cwd: input.cwd,
    signal: controller.signal,
    executor: input.executor,
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
      };
      bag().rows.set(instance.id, row);
    },
    onObserve(snapshot) {
      if (row?.signal === "dropped") return;
      publishObservation(
        {
          ...snapshot,
          planId: input.watch?.planId,
          unitId: input.watch?.unitId,
          teamOwnerToken: input.teamOwner?.token,
        },
        epoch,
      );
    },
  });
  if (!row) {
    await pending;
    throw new Error("agent_spawn did not accept");
  }
  const accepted = row;
  pending.then(
    (result) => settle(accepted, result),
    (error: unknown) =>
      settle(accepted, {
        instanceId: accepted.instanceId,
        role: accepted.roleId,
        status: "failed",
        model: { selectedModel: "unknown" },
        result: error instanceof Error ? error.message : String(error),
      }),
  );
  return {
    instanceId: accepted.instanceId,
    roleId: accepted.roleId,
    status: "running",
    watch: accepted.interest !== undefined,
  };
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
  if (state.owner?.token !== token) return;
  for (const [id, row] of state.rows) {
    if (row.teamOwnerToken && row.teamOwnerToken !== token) continue;
    row.signal = "dropped";
    if (!row.controller.signal.aborted) row.controller.abort();
    state.rows.delete(id);
  }
  state.held = state.held.filter((item) => item.ownerToken !== token);
  state.teamOwners?.delete(token);
  removeUntaggedObservations();
  removeTeamObservations(token);
  state.owner = undefined;
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

function settle(row: Row, result: AgentRunResult): void {
  const state = bag();
  const current = state.rows.get(row.instanceId);
  if (!current || current.signal === "dropped" || current.signal === "sent") return;
  current.outcome = result;
  current.onTeamSettled?.(result.status);
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
