import { randomBytes } from "node:crypto";
import { currentWorkspace } from "../board/workspace.ts";
import { PitakoConfigError } from "../errors.ts";
import { loadPitakoConfig, resolveRoleFromConfig, type LoadOptions } from "../roles/load.ts";
import type { FallbackReason, ModelTarget, ResolvedRole } from "../roles/types.ts";
import { classifyProviderFailure } from "./fallback.ts";
import { formatAgentLive } from "./present.ts";
import { agentScope } from "./scope.ts";
import type { AgentUiSnapshot } from "./ui.ts";
import {
  activityKind,
  createActivity,
  evaluateWatchdog,
  noteActivity,
  noteToolEnd,
  noteToolStart,
  stallInfo,
  syncToolHold,
  startWatchdogTimer,
  PROVIDER_STREAM_TOOL_ID,
  type AgentActivityState,
  type StallInfo,
  type WatchdogConfig,
  type WatchdogPhase,
} from "./watchdog.ts";

export type AgentStatus = "created" | "running" | "completed" | "failed" | "cancelled";

export interface AgentModelProvenance {
  policyId?: string;
  requestedModel?: string;
  selectedModel: string;
  requestedReasoning?: string;
  appliedReasoning?: string;
  /** True only after a fallback target has actually started. */
  fallbackOccurred?: boolean;
  fallbackIndex?: number;
  fallbackReason?: FallbackReason;
  /** Classified failure on the last attempt, even if no fallback started. */
  lastFailure?: FallbackReason;
}

export interface AgentInstance {
  id: string;
  roleId: string;
  workspace: string;
  cwd: string;
  status: AgentStatus;
  model: AgentModelProvenance;
  createdAt: string;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
  tools?: Record<string, number>;
  contextTokens?: number;
}

export interface WatchdogSnapshot {
  elapsedMs: number;
  lastActivityKind: string;
  inactivityMs: number;
  activeTool?: string;
  phase: WatchdogPhase;
}

export interface AgentRunResult {
  instanceId: string;
  role: string;
  status: Exclude<AgentStatus, "created" | "running">;
  model: AgentModelProvenance;
  result: string;
  usage?: AgentUsage;
  watchdog?: WatchdogSnapshot;
}

export interface Attempt {
  status: "completed" | "failed" | "cancelled";
  result: string;
  error?: string;
  sideEffects: boolean;
  usage?: AgentUsage;
  appliedReasoning?: string;
  session?: AttemptSession;
}

export interface AttemptSession {
  continueWith(target: ModelTarget, note: string, signal: AbortSignal): Promise<Attempt>;
  dispose(): Promise<void>;
}

export interface AttemptExecutor {
  start(input: {
    instanceId: string;
    role: ResolvedRole;
    task: string;
    target: ModelTarget;
    cwd: string;
    signal: AbortSignal;
    onActivity?: (event: { type?: string; toolName?: string; assistantMessageEvent?: { type?: string } }) => void;
    /** Fired only after setModel / session open succeeds. Not a second lifecycle. */
    onActivated?: (appliedReasoning: string) => void;
    /** Per attempt. Not stored on a shared executor. Pass undefined to clear. */
    bindActivityProbe?: (probe: (() => { name: string } | undefined) | undefined) => void;
  }): Promise<Attempt>;
}

const SIDE_EFFECT_NOTE = "The previous model became unavailable. Continue from the current session. Do not repeat completed side effects.";

async function runAttempt(
  sideEffects: boolean,
  session: AttemptSession | undefined,
  executor: AttemptExecutor,
  input: {
    instanceId: string;
    role: ResolvedRole;
    task: string;
    target: ModelTarget;
    cwd: string;
    signal: AbortSignal;
    onActivity?: (event: { type?: string; toolName?: string; assistantMessageEvent?: { type?: string } }) => void;
    onActivated?: (appliedReasoning: string) => void;
    bindActivityProbe?: (probe: (() => { name: string } | undefined) | undefined) => void;
  },
): Promise<Attempt> {
  try {
    if (sideEffects) {
      if (!session) {
        return {
          status: "failed",
          result: "",
          error: "cannot continue after side effects without replaying the task",
          sideEffects: true,
        };
      }
      return await session.continueWith(input.target, SIDE_EFFECT_NOTE, input.signal);
    }
    await session?.dispose();
    return await executor.start(input);
  } catch (error) {
    if (input.signal.aborted) {
      return { status: "cancelled", result: "cancelled", sideEffects, session };
    }
    return {
      status: "failed",
      result: "",
      error: error instanceof Error ? error.message : String(error),
      sideEffects,
      session,
    };
  }
}

export function createInstanceId(roleId: string): string {
  return `${roleId}-${randomBytes(3).toString("hex")}`;
}

export function childInstructions(role: ResolvedRole, instanceId: string): string {
  return [
    `You are Pitako AgentInstance ${instanceId}, role ${role.id}.`,
    "Your conversation is private. Do not assume you saw the parent session.",
    "Do not spawn other agents. agent_run, agent_supervise, agent_spawn, agent_status, agent_result, agent_cancel, team_assign, team_status, team_result, and team_cancel are not available.",
    "Publish shared findings on the Board. Board contents are not injected here.",
    "Your rpiv-todo list is private to this session.",
    "The model and reasoning for this run come from this role's ModelPolicy, not from the parent session.",
    "",
    role.instructions,
  ].join("\n");
}

export function skillNamesForRole(role: ResolvedRole): string[] {
  return ["pitako-coding", "ponytail", "caveman", ...role.skills, ...role.principles];
}

export async function runAgentInstance(input: {
  roleId: string;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  executor: AttemptExecutor;
  load?: LoadOptions;
  /** Test clock. Production uses Date.now. */
  now?: () => number;
  /** Test scheduler. Production uses setInterval and unref. */
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  watchdog?: WatchdogConfig;
  /** Live view only. Errors are ignored so UI cannot change the run. */
  onPresent?: (text: string) => void;
  /** Structured observation copy. Errors are ignored so UI cannot change the run. */
  onObserve?: (snapshot: AgentUiSnapshot) => void;
  /** Synchronous accept hook. Runs before watchdog setup and the first await. */
  onAccepted?: (instance: AgentInstance) => void;
}): Promise<AgentRunResult> {
  const task = input.task.trim();
  if (task.length === 0) throw new PitakoConfigError("agent_run task must not be empty");
  const loaded = loadPitakoConfig(input.load);
  const role = resolveRoleFromConfig(loaded, input.roleId);
  if (!role.modelPolicy.primary) {
    throw new PitakoConfigError(role.modelPolicy.diagnostic ?? `model policy "${role.modelPolicyId}" has no primary target`);
  }
  const targets = [role.modelPolicy.primary, ...role.modelPolicy.fallbacks];
  const instance: AgentInstance = {
    id: createInstanceId(role.id),
    roleId: role.id,
    workspace: currentWorkspace(input.cwd),
    cwd: input.cwd,
    status: "created",
    model: {
      policyId: role.modelPolicyId,
      requestedModel: role.modelPolicy.primary.model,
      selectedModel: role.modelPolicy.primary.model,
      requestedReasoning: role.modelPolicy.primary.reasoning,
    },
    createdAt: new Date().toISOString(),
  };
  input.onAccepted?.(instance);
  const now = input.now ?? Date.now;
  const acceptedAt = now();
  const activity = createActivity(acceptedAt);
  const view: { usage?: AgentUsage; error?: string } = {};
  const throughput = createThroughput();
  const work: WorkCounts = { turns: 0, toolCalls: 0 };
  let lastStable = "";
  let terminalAt: number | undefined;
  const present = () => {
    if (!input.onPresent) return;
    const text = formatAgentLive({
      instance,
      task,
      watchdog: snapshot(activity, now()),
      usage: view.usage,
      error: view.error,
    });
    const stable = text.replace(/^elapsed: .*$/m, "elapsed").replace(/inactive [^,\n]*/, "inactive");
    if (stable === lastStable) return;
    try {
      input.onPresent(text);
      lastStable = stable;
    } catch {
      // Presentation must not change fallback, cancellation, or stall behavior.
    }
  };
  const observe = () => {
    if (!input.onObserve) return;
    try {
      input.onObserve(observationOf(instance, task, activity, throughput, work, acceptedAt, terminalAt, now(), view.usage));
    } catch {
      // Observation must not change fallback, cancellation, or stall behavior.
    }
  };
  const refresh = () => {
    present();
    observe();
  };
  const child = new AbortController();
  const stopParent = input.signal ? watchAbort(input.signal, () => child.abort()) : () => {};
  let stall: StallInfo | undefined;
  let activityProbe: (() => { name: string } | undefined) | undefined;
  const bindActivityProbe = (probe: typeof activityProbe) => {
    activityProbe = probe;
    if (!probe) syncToolHold(activity, undefined, now());
  };
  const timer = startWatchdogTimer(() => {
    let hold: { name: string } | undefined;
    try {
      hold = activityProbe?.();
    } catch {
      hold = undefined;
    }
    const t = now();
    const hadHold = activity.runningTools.some((tool) => tool.id === PROVIDER_STREAM_TOOL_ID);
    syncToolHold(activity, hold, t);
    const hasHold = Boolean(hold);
    // Probe hold is not noteActivity. Freeze stream on appear so held time is excluded;
    // publish so activeTool shows (cursor-native) and tok/s hides.
    if (hasHold && !hadHold) freezeStream(throughput, t);
    const before = activity.phase;
    const verdict = evaluateWatchdog(activity, input.watchdog ?? loaded.watchdog, t);
    if (hasHold !== hadHold || activity.phase !== before) refresh();
    if (verdict === "stalled" || verdict === "max_runtime") {
      stall = stallInfo(activity, t, verdict === "max_runtime" ? "max_runtime" : "stalled");
      timer.stop();
      child.abort();
    }
  }, undefined, input.schedule);
  const onActivity = (event: ActivityEvent) => {
    const t = now();
    // Token sample must not call noteActivity or change watchdog phase.
    const sampled = sampleOutputTokens(throughput, event);
    noteWork(work, event);
    const kind = activityKind(event);
    if (kind === "model_stream") noteStreamSample(throughput, activity, t);
    else if (kind === "tool_start") freezeStream(throughput, t);
    if (!kind) {
      if (sampled) observe();
      return;
    }
    if (kind === "tool_start" && event.toolName) noteToolStart(activity, event.toolName, t, event.toolCallId ?? event.toolName);
    else if (kind === "tool_end") noteToolEnd(activity, t, event.toolCallId);
    else noteActivity(activity, kind, t);
    refresh();
  };
  const onActivated = (appliedReasoning: string) => {
    instance.model.appliedReasoning = appliedReasoning;
    refresh();
  };
  refresh();
  try {
    return await agentScope.run({ instanceId: instance.id }, () =>
      executeTargets(
        instance,
        role,
        task,
        targets,
        input.executor,
        child.signal,
        input.signal,
        activity,
        now,
        () => stall,
        onActivity,
        onActivated,
        refresh,
        view,
        bindActivityProbe,
        throughput,
        (at) => {
          terminalAt = at;
        },
      ),
    );
  } finally {
    timer.stop();
    stopParent();
  }
}

async function executeTargets(
  instance: AgentInstance,
  role: ResolvedRole,
  task: string,
  targets: ModelTarget[],
  executor: AttemptExecutor,
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
  activity: AgentActivityState,
  now: () => number,
  stalled: () => StallInfo | undefined,
  onActivity: (event: ActivityEvent) => void,
  onActivated: (appliedReasoning: string) => void,
  present: () => void,
  view: { usage?: AgentUsage; error?: string },
  bindActivityProbe: (probe: (() => { name: string } | undefined) | undefined) => void,
  throughput: ThroughputState,
  markTerminal: (at: number) => void,
): Promise<AgentRunResult> {
  instance.status = "running";
  let session: AttemptSession | undefined;
  let sideEffects = false;
  let lastError = "no model target could be used";
  let usage: AgentUsage | undefined;
  const done = (
    status: AgentRunResult["status"],
    result: string,
    target?: ModelTarget,
    index = 0,
    reason?: FallbackReason,
  ) => {
    view.usage = usage;
    view.error = status === "completed" || result === "cancelled" ? undefined : result;
    markTerminal(now());
    return finish(instance, status, result, target, index, reason, usage, snapshot(activity, now()), present);
  };
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const pendingStall = stalled();
      if (pendingStall && !parentSignal?.aborted) {
        return done("failed", formatStall(pendingStall), targets[index], index);
      }
      if (parentSignal?.aborted) return done("cancelled", "cancelled");
      if (index > 0) noteActivity(activity, "fallback", now());
      noteActivity(activity, "prompt", now());
      const target = targets[index]!;
      instance.model = provenance(instance, target, index);
      resetThroughput(throughput);
      view.error = undefined;
      present();
      const attempt = await runAttempt(sideEffects, session, executor, {
        instanceId: instance.id,
        role,
        task,
        target,
        cwd: instance.cwd,
        signal,
        onActivity,
        onActivated,
        bindActivityProbe,
      });
      bindActivityProbe(undefined);
      const stall = stalled();
      if (stall && !parentSignal?.aborted) {
        return done("failed", formatStall(stall), target, index);
      }
      session = attempt.session ?? session;
      sideEffects = sideEffects || attempt.sideEffects;
      usage = mergeUsage(usage, attempt.usage);
      view.usage = usage;
      if (attempt.appliedReasoning !== undefined) instance.model.appliedReasoning = attempt.appliedReasoning;
      present();
      if (attempt.status === "completed") {
        return done("completed", attempt.result, target, index);
      }
      lastError = attempt.error ?? "agent failed";
      const reason = classifyProviderFailure(attempt.status === "cancelled" ? undefined : lastError);
      if (reason) instance.model.lastFailure = reason;
      if (attempt.status === "cancelled" || parentSignal?.aborted || signal.aborted) {
        return done("cancelled", attempt.result || "cancelled");
      }
      const more = index + 1 < targets.length;
      if (!reason || !more) {
        return done("failed", lastError, target, index, reason);
      }
      instance.model.lastFailure = reason;
      if (!sideEffects) {
        await session?.dispose();
        session = undefined;
      }
    }
    return done("failed", lastError, targets[targets.length - 1], targets.length - 1);
  } finally {
    await session?.dispose();
  }
}

function provenance(instance: AgentInstance, target: ModelTarget, index: number): AgentModelProvenance {
  return {
    policyId: instance.model.policyId,
    requestedModel: instance.model.requestedModel,
    selectedModel: target.model,
    requestedReasoning: target.reasoning,
    appliedReasoning: undefined,
    fallbackOccurred: index > 0,
    fallbackIndex: index === 0 ? undefined : index - 1,
    fallbackReason: index === 0 ? undefined : instance.model.lastFailure,
    lastFailure: instance.model.lastFailure,
  };
}

function finish(
  instance: AgentInstance,
  status: AgentRunResult["status"],
  result: string,
  target: ModelTarget | undefined,
  index = 0,
  reason?: FallbackReason,
  usage?: AgentUsage,
  watchdog?: WatchdogSnapshot,
  present?: () => void,
): AgentRunResult {
  instance.status = status;
  if (target) {
    instance.model.selectedModel = target.model;
    instance.model.requestedReasoning = target.reasoning;
    instance.model.fallbackIndex = index === 0 ? undefined : index - 1;
    if (reason) instance.model.fallbackReason = reason;
  }
  present?.();
  return {
    instanceId: instance.id,
    role: instance.roleId,
    status,
    model: instance.model,
    result,
    usage,
    watchdog,
  };
}

function snapshot(state: AgentActivityState, now: number): WatchdogSnapshot {
  return {
    elapsedMs: now - state.startedAt,
    lastActivityKind: state.lastActivityKind,
    inactivityMs: now - state.lastActivityAt,
    activeTool: state.activeTool?.name,
    phase: state.phase,
  };
}

type ActivityEvent = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  message?: { role?: string; usage?: { output?: number } };
  assistantMessageEvent?: {
    type?: string;
    partial?: { usage?: { output?: number } };
  };
};

interface WorkCounts {
  turns: number;
  toolCalls: number;
}

function noteWork(counts: WorkCounts, event: ActivityEvent): void {
  if (event.type === "tool_execution_start") counts.toolCalls += 1;
  if (event.type === "message_end" && event.message?.role === "assistant") counts.turns += 1;
}

interface ThroughputState {
  outputTokens?: number;
  streamAccumMs: number;
  streamAnchor?: number;
}

function createThroughput(): ThroughputState {
  return { streamAccumMs: 0 };
}

function resetThroughput(state: ThroughputState): void {
  state.outputTokens = undefined;
  state.streamAccumMs = 0;
  state.streamAnchor = undefined;
}

/** Finite usage.output > 0 only. Does not touch watchdog. */
function sampleOutputTokens(state: ThroughputState, event: ActivityEvent): boolean {
  const candidates = [event.message?.usage?.output, event.assistantMessageEvent?.partial?.usage?.output];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      state.outputTokens = value;
      return true;
    }
  }
  return false;
}

/** Open-stream sample: include time since anchor. No-op while a tool is active. */
function noteStreamSample(state: ThroughputState, activity: AgentActivityState, now: number): void {
  if (activity.activeTool) return;
  if (state.streamAnchor === undefined) state.streamAnchor = now;
}

function freezeStream(state: ThroughputState, now: number): void {
  if (state.streamAnchor === undefined) return;
  state.streamAccumMs += Math.max(0, now - state.streamAnchor);
  state.streamAnchor = undefined;
}

function streamMsOf(state: ThroughputState, now: number, activity: AgentActivityState): number | undefined {
  if (state.streamAnchor === undefined && state.streamAccumMs === 0) return undefined;
  let ms = state.streamAccumMs;
  if (state.streamAnchor !== undefined && !activity.activeTool) {
    ms += Math.max(0, now - state.streamAnchor);
  }
  return ms;
}

function observationOf(
  instance: AgentInstance,
  task: string,
  activity: AgentActivityState,
  throughput: ThroughputState,
  work: WorkCounts,
  acceptedAt: number,
  terminalAt: number | undefined,
  now: number,
  usage: AgentUsage | undefined,
): AgentUiSnapshot {
  const dog = snapshot(activity, now);
  const status = instance.status;
  const streamMs = streamMsOf(throughput, now, activity);
  const outputTokens = throughput.outputTokens ?? (usage?.output && usage.output > 0 ? usage.output : undefined);
  const turns = Math.max(work.turns, usage?.turns ?? 0);
  const toolCalls = Math.max(work.toolCalls, usage?.toolCalls ?? 0);
  return {
    id: instance.id,
    roleId: instance.roleId,
    status,
    phase: dog.phase,
    task,
    acceptedAt,
    terminalAt,
    selectedModel: instance.model.selectedModel,
    requestedModel: instance.model.requestedModel,
    appliedReasoning: instance.model.appliedReasoning,
    requestedReasoning: instance.model.requestedReasoning,
    fallbackOccurred: instance.model.fallbackOccurred,
    fallbackReason: instance.model.fallbackReason,
    activeTool: activity.activeTool ? { name: activity.activeTool.name, startedAt: activity.activeTool.startedAt } : undefined,
    lastActivityKind: dog.lastActivityKind,
    outputTokens,
    streamMs,
    turns: turns > 0 ? turns : undefined,
    toolCalls: toolCalls > 0 ? toolCalls : undefined,
    inactivityMs: dog.inactivityMs,
    failureKind: status === "failed" ? dog.lastActivityKind : undefined,
  };
}

function formatStall(info: StallInfo): string {
  const tool = info.activeTool ? ` during ${info.activeTool}` : "";
  if (info.kind === "max_runtime") return `max runtime exceeded after ${info.elapsedMs}ms`;
  return `stalled: no ${info.lastActivityKind} for ${info.inactivityMs}ms${tool}`;
}

function watchAbort(signal: AbortSignal, abort: () => void): () => void {
  if (signal.aborted) {
    abort();
    return () => {};
  }
  const onAbort = () => abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", onAbort);
}

export function formatAgentResult(result: AgentRunResult): string {
  const requested = result.model.requestedModel && result.model.requestedModel !== result.model.selectedModel
    ? `\nrequested: ${result.model.requestedModel}`
    : "";
  const stalled = result.watchdog
    ? `\nwatchdog: ${result.watchdog.phase}, last activity ${result.watchdog.lastActivityKind}, inactive ${result.watchdog.inactivityMs}ms`
    : "";
  const fallback = result.model.fallbackOccurred && result.model.fallbackReason
    ? `\nfallback: ${result.model.fallbackReason} from ${result.model.requestedModel ?? "primary"}`
    : "";
  const usage = result.usage ? `\n${formatUsage(result.usage)}` : "";
  return [
    `${result.instanceId} ${result.status}`,
    `role: ${result.role}`,
    `model: ${result.model.selectedModel}`,
    requested,
    `reasoning requested: ${result.model.requestedReasoning ?? "default"}`,
    `reasoning applied: ${result.model.appliedReasoning ?? "unknown"}`,
    stalled,
    fallback,
    usage,
    "",
    result.result,
  ].filter((line) => line.length > 0).join("\n");
}

export function formatUsage(usage: AgentUsage): string {
  const lines = ["usage:", `  input: ${usage.input}`, `  output: ${usage.output}`];
  if (usage.cacheRead !== undefined) lines.push(`  cached read: ${usage.cacheRead}`);
  if (usage.cacheWrite !== undefined) lines.push(`  cached write: ${usage.cacheWrite}`);
  if (usage.cost !== undefined) lines.push(`  cost: ${usage.cost}`);
  lines.push(`  turns: ${usage.turns ?? "?"}`, `  tools: ${usage.toolCalls ?? "?"}`);
  if (usage.contextTokens !== undefined) lines.push(`  context: ${usage.contextTokens}`);
  return lines.join("\n");
}

/** Counters are subtracted. contextTokens is a gauge and keeps the later value. */
export function usageDelta(before: AgentUsage | undefined, after: AgentUsage | undefined): AgentUsage | undefined {
  if (!after) return undefined;
  if (!before) return { ...after, tools: after.tools ? { ...after.tools } : undefined };
  const tools: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before.tools ?? {}), ...Object.keys(after.tools ?? {})])) {
    const delta = (after.tools?.[name] ?? 0) - (before.tools?.[name] ?? 0);
    if (delta > 0) tools[name] = delta;
  }
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, (after.cacheRead ?? 0) - (before.cacheRead ?? 0)),
    cacheWrite: Math.max(0, (after.cacheWrite ?? 0) - (before.cacheWrite ?? 0)),
    total: Math.max(0, (after.total ?? 0) - (before.total ?? 0)),
    cost: Math.max(0, (after.cost ?? 0) - (before.cost ?? 0)),
    turns: Math.max(0, (after.turns ?? 0) - (before.turns ?? 0)),
    toolCalls: Math.max(0, (after.toolCalls ?? 0) - (before.toolCalls ?? 0)),
    tools,
    contextTokens: after.contextTokens,
  };
}

export function mergeUsage(left: AgentUsage | undefined, right: AgentUsage | undefined): AgentUsage | undefined {
  if (!right) return left;
  if (!left) return { ...right, tools: right.tools ? { ...right.tools } : undefined };
  const tools = { ...(left.tools ?? {}) };
  for (const [name, count] of Object.entries(right.tools ?? {})) tools[name] = (tools[name] ?? 0) + count;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: (left.cacheRead ?? 0) + (right.cacheRead ?? 0),
    cacheWrite: (left.cacheWrite ?? 0) + (right.cacheWrite ?? 0),
    total: (left.total ?? 0) + (right.total ?? 0),
    cost: (left.cost ?? 0) + (right.cost ?? 0),
    turns: (left.turns ?? 0) + (right.turns ?? 0),
    toolCalls: (left.toolCalls ?? 0) + (right.toolCalls ?? 0),
    tools,
    contextTokens: right.contextTokens ?? left.contextTokens,
  };
}
