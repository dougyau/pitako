import { randomBytes } from "node:crypto";
import { currentWorkspace } from "../board/workspace.ts";
import { PitakoConfigError } from "../errors.ts";
import { loadPitakoConfig, resolveDeveloperHeadFromConfig, resolveRoleFromConfig, type LoadOptions } from "../roles/load.ts";
import type { FallbackReason, ModelTarget, ResolvedRole } from "../roles/types.ts";
import { classifyProviderFailure, isServiceTierRejection } from "./fallback.ts";
import { formatAgentLive } from "./present.ts";
import { agentScope } from "./scope.ts";
import type { AgentUiSnapshot } from "./ui.ts";
import { InvocationHistory, type HistoryOrigin } from "./history.ts";
import { AgentClosureError } from "./closure.ts";
import type { HeadAttachment, LeafScopeAttachment } from "./head/runtime.ts";
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

export interface AgentRequestObservation {
  turnId?: string;
  attemptId?: string;
  historyId?: string;
  sessionId?: string;
  /** Actual SDK stream input, not provider-internal execution. */
  sdkOptions?: { reasoning?: string; temperature?: number; maxTokens?: number; serviceTier?: string };
  model: string;
  provider?: string;
  requestId?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoning?: string;
  fast_requested: boolean;
  requested_service_tier?: "fast" | "priority";
  returned_service_tier: "unavailable";
  time_to_first_model_output_ms: number | "unavailable";
  time_to_first_model_output_unavailable_reason?: "cancelled" | "failed";
}

export interface AgentRunResult {
  instanceId: string;
  turnId?: string;
  role: string;
  status: Exclude<AgentStatus, "created" | "running">;
  model: AgentModelProvenance;
  result: string;
  requests?: AgentRequestObservation[];
  usage?: AgentUsage;
  watchdog?: WatchdogSnapshot;
  head?: import("./head/runtime.ts").HeadHandoff;
}

export interface TeamExecutionSummary {
  assignmentId: string;
  selectedModel: string | null;
  provider: string | null;
  appliedReasoning: string;
  elapsedMs: number | null;
  turns: number | null;
  toolCalls: number | null;
  tools: Record<string, number> | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  contextTokens: number | null;
  estimatedCost: number | null;
}

export interface Attempt {
  status: "completed" | "failed" | "cancelled";
  result: string;
  error?: string;
  failureKind?: "configuration";
  sideEffects: boolean;
  requests?: AgentRequestObservation[];
  usage?: AgentUsage;
  appliedReasoning?: string;
  provenance?: { configured?: { level?: string }; requestedReasoning?: string; selected: ModelTarget; activatedModel?: string; appliedReasoning?: string; adjustment?: string };
  session?: AttemptSession;
}

export type AttemptTurn = Pick<Parameters<AttemptExecutor["start"]>[0],
  "turnId" | "attemptId" | "task" | "target" | "signal" | "onActivity" | "onActivated" | "onRequest" | "bindActivityProbe" | "participant">;

export interface AttemptSession {
  /** A new host-admitted logical turn, not a provider retry. */
  turn?(input: AttemptTurn): Promise<Attempt>;
  retryBeforePrompt?(target: ModelTarget, signal: AbortSignal): Promise<Attempt>;
  continueWith(target: ModelTarget, note: string, signal: AbortSignal, operation?: AttemptTurn): Promise<Attempt>;
  dispose(signal?: AbortSignal): Promise<void>;
}

export interface AttemptExecutor {
  capturesHistory?: boolean;
  capturesPublicConversation?: boolean;
  start(input: {
    instanceId: string;
    turnId?: string;
    attemptId?: string;
    role: ResolvedRole;
    task: string;
    target: ModelTarget;
    cwd: string;
    signal: AbortSignal;
    /** Host-granted assignment authority, never a public tool parameter. */
    head?: HeadAttachment;
    /** Host-only acknowledgment for one Head-owned leaf; never grants orchestration. */
    scope?: LeafScopeAttachment;
    consultant?: import("./head/runtime.ts").ConsultationAttachment;
    participant?: import("../architecture/types.ts").Participant;
    history?: InvocationHistory;
    onActivity?: (event: ActivityEvent) => void;
    /** Fired only after setModel / session open succeeds. Not a second lifecycle. */
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    /** Per attempt. Not stored on a shared executor. Pass undefined to clear. */
    bindActivityProbe?: (probe: (() => { name: string } | undefined) | undefined) => void;
    bindLive?: (handle: import("./live.ts").LiveHandle) => (() => void);
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
    head?: HeadAttachment;
    history?: InvocationHistory;
    onActivity?: (event: ActivityEvent) => void;
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
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
      return await session.continueWith(input.target, SIDE_EFFECT_NOTE, input.signal, input);
    }
    if (session?.retryBeforePrompt) return await session.retryBeforePrompt(input.target, input.signal);
    await session?.dispose();
    return await executor.start(input);
  } catch (error) {
    if (error instanceof AgentClosureError) throw error;
    if (input.signal.aborted) {
      return { status: "cancelled", result: "cancelled", sideEffects, session };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      result: "",
      error: message,
      failureKind: isServiceTierRejection(message) ? "configuration" : undefined,
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
    ...(role.id === "developer_head"
      ? ["Use only your host-granted head_* tools to coordinate local Developer leaves. Public agent_* and team_* orchestration remains unavailable."]
      : ["Do not spawn other agents. agent_run, agent_supervise, agent_spawn, agent_status, agent_result, agent_observe, agent_input, agent_cancel, agent_checkpoints, team_assign, team_status, team_result, and team_cancel are not available."]),
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

export interface AgentRunInput {
  roleId: string;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  executor: AttemptExecutor;
  load?: LoadOptions;
  /** Physical root captured from the frozen execution ledger. */
  executionRoot?: string;
  historyOrigin?: HistoryOrigin;
  dispatch?: import("./routing.ts").DispatchSnapshot;
  consultation?: import("./consultation.ts").ConsultationSnapshot;
  architecture?: { config: import("../roles/types.ts").PitakoConfig; role: ResolvedRole; participant: import("../architecture/types.ts").Participant };
  reservedInstanceId?: string;
  head?: HeadAttachment;
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
}

interface ConversationState {
  instance?: AgentInstance;
  history?: InvocationHistory;
  session?: AttemptSession;
  turn: number;
  attempt: number;
}

/** Owns native resources across turns. Busy includes the outer prompt and its callbacks. */
export function createConversationOwner(input: AgentRunInput) {
  input = { ...input, reservedInstanceId: input.reservedInstanceId ?? createInstanceId(input.roleId) };
  const state: ConversationState = { turn: 0, attempt: 0 };
  const lifetime = new AbortController();
  let active: Promise<AgentRunResult> | undefined;
  let closing: Promise<void> | undefined;
  let revoked = false;
  let closureFailure: AgentClosureError | undefined;
  const abort = () => {
    revoked = true;
    input.head?.revoke();
    lifetime.abort();
  };
  const stopParent = input.signal ? watchAbort(input.signal, abort) : () => {};
  return {
    get instanceId() { return state.instance?.id ?? input.reservedInstanceId; },
    get busy() { return active !== undefined; },
    turn(task = input.task, options: Partial<Pick<AgentRunInput, "signal" | "onObserve" | "onPresent">> = {}): Promise<AgentRunResult> {
      // Preserve one-shot pre-abort: its first operation reports cancellation without starting an executor.
      if (closing || revoked && !(state.turn === 0 && input.signal?.aborted))
        return Promise.reject(new Error("Agent conversation is closing"));
      if (active) return Promise.reject(new Error("Agent conversation is busy"));
      const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
      const turnId = `${input.reservedInstanceId ?? state.instance?.id ?? "turn"}:turn:${++state.turn}`;
      // Busy is installed before preparation, including synchronous observers.
      const completion = Promise.withResolvers<AgentRunResult>();
      const pending = completion.promise;
      active = pending;
      void runConversationTurn({ ...input, ...options, task, signal }, state, turnId).then(completion.resolve, completion.reject);
      void pending.then(
        result => { if (result.status === "cancelled") abort(); active = undefined; },
        error => { if (error instanceof AgentClosureError) { closureFailure = error; abort(); } active = undefined; },
      );
      return pending;
    },
    abort,
    close(): Promise<void> {
      if (closing) return closing;
      abort();
      closing = (async () => {
        const failures: unknown[] = closureFailure ? [closureFailure] : [];
        try { await active; } catch (error) { if (error instanceof AgentClosureError) failures.push(error); }
        const closures = await Promise.allSettled([input.head?.close(), state.session?.dispose(input.signal)]);
        failures.push(...closures.flatMap(result => result.status === "rejected" ? [result.reason] : []));
        stopParent();
        if (failures.length) {
          const error = new AgentClosureError(failures, `AgentInstance ${state.instance?.id ?? "startup"}`);
          input.head?.retainUnknown(error);
          throw error;
        }
        state.history?.settled();
      })();
      return closing;
    },
  };
}

/** One-shot, including Head: close before handing off the result. */
export async function runAgentInstance(input: AgentRunInput): Promise<AgentRunResult> {
  const owner = createConversationOwner(input);
  let result: AgentRunResult;
  try { result = await owner.turn(); } finally { await owner.close(); }
  if (input.head?.dag) {
    result.head = input.head.dag.handoff(result);
    if (result.status === "completed" || (result.status === "cancelled" && !input.signal?.aborted &&
        input.head.dag.finishStatus === "failed")) {
      result.status = result.head.finish.status;
      result.result = result.head.finish.status === "completed" ? result.head.finish.summary : result.head.finish.diagnostic;
    }
  }
  return result;
}

async function runConversationTurn(input: AgentRunInput, state: ConversationState, turnId: string): Promise<AgentRunResult> {
  const task = input.task.trim();
  if (task.trim().length === 0) throw new PitakoConfigError("agent_run task must not be empty");
  const workspace = currentWorkspace(input.cwd);
  if (input.executionRoot !== undefined && workspace !== input.executionRoot) {
    throw new PitakoConfigError(`AgentInstance workspace drift: expected ${input.executionRoot}, got ${workspace}`);
  }
  const loaded = input.head?.dag?.configSnapshot ?? input.dispatch?.config ?? input.consultation?.config ?? input.architecture?.config ?? loadPitakoConfig(input.load);
  const role = input.head?.dag ? resolveDeveloperHeadFromConfig(input.head.dag.configSnapshot)
    : input.dispatch?.role ?? input.consultation?.role ?? input.architecture?.role ?? resolveRoleFromConfig(loaded, input.roleId);
  if (role.id !== input.roleId && !(input.head?.dag && input.roleId === "developer")) {
    throw new PitakoConfigError("dispatch snapshot role does not match runner role");
  }
  if (!role.modelPolicy.primary) {
    throw new PitakoConfigError(role.modelPolicy.diagnostic ?? `model policy "${role.modelPolicyId}" has no primary target`);
  }
  const targets = [role.modelPolicy.primary, ...role.modelPolicy.fallbacks];
  const instance: AgentInstance = state.instance ?? {
    id: input.reservedInstanceId ?? createInstanceId(role.id),
    roleId: input.roleId,
    workspace,
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
  state.instance = instance;
  const origin: HistoryOrigin | undefined = input.head?.dag || input.historyOrigin ? structuredClone({
    ...input.historyOrigin, source: input.historyOrigin?.source ?? "agent_run", turnId,
    workbrief: input.historyOrigin?.workbrief ?? input.task,
    ...(input.head ? { assignmentId: input.head.assignmentId,
      head: { assignmentId: input.head.assignmentId, headInstanceId: instance.id } } : {}),
  }) : undefined;
  if (input.head && state.turn === 1) {
    if (input.roleId !== "developer") throw new PitakoConfigError("Head attachment requires a Developer assignment");
    input.head.claim(instance.id, workspace);
    input.head.captureOrigin(origin);
  }
  try { if (state.turn === 1) input.onAccepted?.(instance); } catch (error) {
    await input.head?.close();
    throw error;
  }
  let history: InvocationHistory | undefined;
  const now = input.now ?? Date.now;
  const acceptedAt = now();
  const activity = createActivity(acceptedAt);
  const view: { usage?: AgentUsage; error?: string } = {};
  const throughput = createThroughput();
  const work: WorkCounts = { turns: 0, toolCalls: 0 };
  let attemptId: string | undefined;
  let activated: AgentUiSnapshot["activated"];
  const sdkRequests: AgentRequestObservation[] = [];
  let sdkRequestsDropped = 0;
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
      input.onObserve({ ...observationOf(instance, task, activity, throughput, work, acceptedAt, terminalAt, now(), view.usage),
        origin, turnId, attemptId, activated, sdkRequests: sdkRequests.map(request => ({ ...request })), sdkRequestsDropped });
    } catch {
      // Observation must not change fallback, cancellation, or stall behavior.
    }
  };
  const refresh = () => {
    present();
    observe();
  };
  const child = new AbortController();
  const cancel = () => { input.head?.revoke(); child.abort(); };
  const stopParent = input.signal ? watchAbort(input.signal, cancel) : () => {};
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
      cancel();
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
    activated = { attemptId: attemptId!, model: instance.model.selectedModel, reasoning: appliedReasoning };
    refresh();
  };
  const onRequest = (request: AgentRequestObservation) => {
    request.turnId = turnId;
    request.attemptId = attemptId;
    sdkRequests.push(request);
    if (sdkRequests.length > 50) { sdkRequests.shift(); sdkRequestsDropped++; }
    refresh();
  };
  refresh();
  try {
    // Publish accepted provenance before history/SDK setup can fail or await.
    history = state.history ??= input.executor.capturesHistory ? new InvocationHistory(instance.cwd, origin, input.task) : undefined;
    const result = await agentScope.run({ instanceId: instance.id, roleId: role.id }, () =>
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
        onRequest,
        () => { attemptId = `${instance.id}:${++state.attempt}`; activated = undefined; },
        refresh,
        view,
        bindActivityProbe,
        throughput,
        work,
        (at) => {
          terminalAt = at;
        },
        history,
        input.head,
        state,
        input.architecture?.participant,
      ),
    );
    if (history && !history.admitted) history.admit(instance.id, role.id, targets[0]!).result({
      status: result.status, result: result.result,
      error: result.status === "failed" ? result.result : undefined, sideEffects: false,
    });
    result.turnId = turnId;
    return result;
  } catch (error) {
    instance.status = "failed";
    terminalAt = now();
    view.error = error instanceof Error ? error.message : String(error);
    refresh();
    throw error;
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
  onRequest: (request: AgentRequestObservation) => void,
  onAttempt: (index: number) => void,
  present: () => void,
  view: { usage?: AgentUsage; error?: string },
  bindActivityProbe: (probe: (() => { name: string } | undefined) | undefined) => void,
  throughput: ThroughputState,
  work: WorkCounts,
  markTerminal: (at: number) => void,
  history?: InvocationHistory,
  head?: HeadAttachment,
  owner?: ConversationState,
  participant?: import("../architecture/types.ts").Participant,
): Promise<AgentRunResult> {
  instance.status = "running";
  let session = owner?.session;
  let sideEffects = Boolean(session && owner && owner.turn > 1);
  let lastError = "no model target could be used";
  let usage: AgentUsage | undefined;
  const preserveUnknownUsage = Boolean(owner || head || history?.origin?.head || history?.origin?.consultation);
  let missingUsage = false;
  const requests: AgentRequestObservation[] = [];
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
    return finish(instance, status, result, target, index, reason, requests, usage, snapshot(activity, now()), present);
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
      onAttempt(index);
      instance.model = provenance(instance, target, index);
      resetThroughput(throughput);
      view.error = undefined;
      present();
      const operation = {
        instanceId: instance.id,
        turnId: owner ? `${instance.id}:turn:${owner.turn}` : undefined,
        attemptId: owner ? `${instance.id}:${owner.attempt}` : undefined,
        role,
        task,
        target,
        cwd: instance.cwd,
        signal,
        onActivity,
        onActivated,
        onRequest,
        bindActivityProbe,
        history,
        head,
        participant,
      };
      const attempt = index === 0 && session && owner && owner.turn > 1
        ? session.turn ? await session.turn(operation) : { status: "failed" as const, result: "", error: "session cannot accept a new logical turn", sideEffects: false, session }
        : await runAttempt(sideEffects, session, executor, operation);
      bindActivityProbe(undefined);
      missingUsage ||= preserveUnknownUsage && attempt.usage === undefined;
      usage = missingUsage ? undefined : mergeUsage(usage, attempt.usage, preserveUnknownUsage);
      if (attempt.requests) requests.push(...attempt.requests);
      session = attempt.session ?? session;
      if (owner) owner.session = session;
      const stall = stalled();
      if (stall && !parentSignal?.aborted) {
        return done("failed", formatStall(stall), target, index);
      }
      sideEffects = sideEffects || attempt.sideEffects || head?.sideEffects === true || !!(participant && session && !session.retryBeforePrompt);
      view.usage = usage;
      if (attempt.appliedReasoning !== undefined) instance.model.appliedReasoning = attempt.appliedReasoning;
      present();
      if (participant?.failure) return done("failed", participant.failure, target, index);
      if (attempt.status === "completed") {
        return done("completed", attempt.result, target, index);
      }
      lastError = attempt.error ?? "agent failed";
      if (attempt.failureKind === "configuration" || isServiceTierRejection(lastError)) {
        return done("failed", lastError, target, index);
      }
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
      if (!sideEffects && !session?.retryBeforePrompt) {
        await session?.dispose();
        session = undefined;
      }
    }
    return done("failed", lastError, targets[targets.length - 1], targets.length - 1);
  } finally {
    if (owner) owner.session = session;
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
  requests?: AgentRequestObservation[],
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
    requests: requests?.length ? requests : undefined,
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
  args?: unknown;
  result?: unknown;
  isError?: boolean;
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
    agentUsage: usage,
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
  const requests = result.requests?.map((request) => {
    const ttft = typeof request.time_to_first_model_output_ms === "number"
      ? `${request.time_to_first_model_output_ms}ms`
      : `unavailable (${request.time_to_first_model_output_unavailable_reason})`;
    return `\nrequest: ${request.model}; reasoning: ${request.reasoning ?? "default"}; fast_requested: ${request.fast_requested}; requested_service_tier: ${request.requested_service_tier ?? "none"}; returned_service_tier: ${request.returned_service_tier}; time_to_first_model_output_ms: ${ttft}`;
  }).join("") ?? "";
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
    requests,
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
  lines.push(`  mutations: edit ${usage.tools?.edit ?? 0}, write ${usage.tools?.write ?? 0}, apply_patch ${usage.tools?.apply_patch ?? 0}`);
  if (usage.contextTokens !== undefined) lines.push(`  context: ${usage.contextTokens}`);
  return lines.join("\n");
}

export function teamExecutionSummary(assignmentId: string, result: AgentRunResult): TeamExecutionSummary {
  const selectedModel = result.model.selectedModel === "unknown" ? null : result.model.selectedModel;
  const separator = selectedModel?.indexOf("/") ?? -1;
  const provider = selectedModel && separator > 0 && separator < selectedModel.length - 1 ? selectedModel.slice(0, separator) : null;
  const usage = result.usage;
  // Pi defaults unspecified model pricing to zero rates, so token-bearing $0 is not a reliable estimate.
  const hasTokens = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].some((value) => value !== undefined && value > 0);
  return {
    assignmentId,
    selectedModel,
    provider,
    appliedReasoning: result.model.appliedReasoning ?? "unknown",
    elapsedMs: result.watchdog?.elapsedMs ?? null,
    turns: usage?.turns ?? null,
    toolCalls: usage?.toolCalls ?? null,
    tools: usage?.tools === undefined ? null : { ...usage.tools },
    input: usage?.input ?? null,
    output: usage?.output ?? null,
    cacheRead: usage?.cacheRead ?? null,
    cacheWrite: usage?.cacheWrite ?? null,
    contextTokens: usage?.contextTokens ?? null,
    estimatedCost: usage?.cost === undefined || (usage.cost === 0 && hasTokens) ? null : usage.cost,
  };
}

export function formatTeamExecutionSummary(summary: TeamExecutionSummary): string {
  const value = (item: number | null) => item === null ? "unavailable" : String(item);
  const tools = summary.tools === null
    ? "unavailable"
    : Object.entries(summary.tools).map(([name, count]) => `${name}:${count}`).join(",") || "none";
  const cost = summary.estimatedCost === null ? "unavailable" : `$${summary.estimatedCost.toFixed(6)} (Pi estimate; not billing)`;
  return `execution summary: assignment=${summary.assignmentId} selected_model=${summary.selectedModel ?? "unavailable"} provider=${summary.provider ?? "unavailable"} applied_reasoning=${summary.appliedReasoning} elapsed_ms=${value(summary.elapsedMs)} turns=${value(summary.turns)} tool_calls=${value(summary.toolCalls)} tools=${tools} input=${value(summary.input)} output=${value(summary.output)} cache_read=${value(summary.cacheRead)} cache_write=${value(summary.cacheWrite)} context_tokens=${value(summary.contextTokens)} estimated_cost=${cost}`;
}

/** Counters are subtracted. contextTokens is a gauge and keeps the later value. */
export function usageDelta(before: AgentUsage | undefined, after: AgentUsage | undefined, preserveUnknown = false): AgentUsage | undefined {
  if (!after) return undefined;
  if (!before) return { ...after, tools: after.tools ? { ...after.tools } : undefined };
  const tools: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before.tools ?? {}), ...Object.keys(after.tools ?? {})])) {
    const delta = (after.tools?.[name] ?? 0) - (before.tools?.[name] ?? 0);
    if (delta > 0) tools[name] = delta;
  }
  const result: AgentUsage = {
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
  if (preserveUnknown) {
    for (const field of ["cacheRead", "cacheWrite", "total", "cost", "turns", "toolCalls"] as const) {
      if (before[field] === undefined || after[field] === undefined) result[field] = undefined;
    }
  }
  return result;
}

export function mergeUsage(left: AgentUsage | undefined, right: AgentUsage | undefined, preserveUnknown = false): AgentUsage | undefined {
  if (!right) return left;
  if (!left) return { ...right, tools: right.tools ? { ...right.tools } : undefined };
  const tools = { ...(left.tools ?? {}) };
  for (const [name, count] of Object.entries(right.tools ?? {})) tools[name] = (tools[name] ?? 0) + count;
  const result: AgentUsage = {
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
  if (preserveUnknown) {
    for (const field of ["cacheRead", "cacheWrite", "total", "cost", "turns", "toolCalls"] as const) {
      if (left[field] === undefined || right[field] === undefined) result[field] = undefined;
    }
  }
  return result;
}
