import { PitakoConfigError } from "../errors.ts";
import { createPiExecutor } from "./pi.ts";
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
}

interface Bag {
  rows: Map<string, Row>;
  owner?: BackgroundOwner;
  held: string[];
  executor?: AttemptExecutor;
}

const KEY = Symbol.for("pitako.backgroundWorkers");

function bag(): Bag {
  const host = globalThis as Record<symbol, Bag | undefined>;
  const existing = host[KEY];
  if (existing) return existing;
  const created: Bag = { rows: new Map(), held: [] };
  host[KEY] = created;
  return created;
}

export function bindBackgroundOwner(owner: BackgroundOwner): void {
  bag().owner = owner;
}

export function clearBackgroundOwner(): void {
  bag().owner = undefined;
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
}): string {
  const base = `Pitako worker ${input.instanceId} ${input.status} role ${input.roleId}.`;
  if (input.channel === "notify" || !input.interest) return base;
  return `${base.slice(0, -1)} plan ${input.interest.planId} unit ${input.interest.unitId}. Use agent_result. Do not do this role's work.`;
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
}): Promise<WorkerHandle> {
  if (input.foreground?.aborted) throw new Error("agent_spawn cancelled");
  const controller = new AbortController();
  const now = input.now ?? Date.now;
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
      };
      bag().rows.set(instance.id, row);
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
  const rows = [...bag().rows.values()];
  const matched = instanceId ? rows.filter((row) => row.instanceId === instanceId) : rows;
  if (instanceId && matched.length === 0) throw new Error(`unknown worker ${instanceId}`);
  return matched.map((row) => view(row, now()));
}

export function workerResult(instanceId: string): AgentRunResult {
  const row = bag().rows.get(instanceId);
  if (!row) throw new Error(`unknown worker ${instanceId}`);
  if (!row.outcome) {
    throw new Error(statusOf(row) === "running" ? "worker is still running" : "result is not available");
  }
  return row.outcome;
}

export function cancelWorker(instanceId: string, now: () => number = Date.now): WorkerView {
  const row = bag().rows.get(instanceId);
  if (!row) throw new Error(`unknown worker ${instanceId}`);
  if (!row.outcome && !row.controller.signal.aborted) row.controller.abort();
  return view(row, now());
}

export function cancelAllWorkers(): void {
  const state = bag();
  for (const row of state.rows.values()) {
    row.signal = "dropped";
    if (!row.controller.signal.aborted) row.controller.abort();
  }
  state.rows.clear();
  state.held = [];
}

export function shutdownBackground(token: symbol): void {
  const state = bag();
  if (state.owner?.token !== token) return;
  cancelAllWorkers();
  state.owner = undefined;
}

export function takeHeldCompletions(token: symbol): string | undefined {
  const state = bag();
  if (state.owner?.token !== token || !state.owner.isIdle() || state.held.length === 0) return undefined;
  const text = state.held.join("\n");
  state.held = [];
  for (const row of state.rows.values()) {
    if (row.signal === "held") row.signal = "sent";
  }
  return text;
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
  const channel = deliveryFor(current.interest !== undefined, idleOf(state.owner));
  const text = completionText({
    instanceId: current.instanceId,
    roleId: current.roleId,
    status: result.status,
    interest: current.interest,
    channel: channel === "hold" ? "wake" : channel,
  });
  if (channel === "hold") {
    current.signal = "held";
    state.held.push(text);
    return;
  }
  current.signal = "sent";
  if (channel === "notify") {
    if (state.owner?.hasUI) state.owner.notify(text);
    return;
  }
  state.owner?.sendMessage(text);
}

function idleOf(owner: BackgroundOwner | undefined): boolean {
  if (!owner) return false;
  try {
    return owner.isIdle();
  } catch {
    return false;
  }
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
