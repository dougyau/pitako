import { AsyncLocalStorage } from "node:async_hooks";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, getSupportedThinkingLevels, lazyStream, normalizeContext, type AssistantMessageEvent, type Context, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerExecution, unregisterExecution } from "../execution-identity.ts";
import { reconcileChildTools, ORCHESTRATION_TOOLS, isOrchestrationTool } from "../profile.ts";
import { packageRoot } from "../stack.ts";
import { marksSideEffect } from "./effects.ts";
import { isServiceTierRejection } from "./fallback.ts";
import { SubmissionError } from "../architecture/protocol.ts";
import { childInstructions, skillNamesForRole, usageDelta, type AgentRequestObservation, type AgentUsage, type Attempt, type AttemptExecutor } from "./run.ts";
import type { ModelTarget, ReasoningLevel } from "../roles/types.ts";
import { InvocationHistory, type SessionHistory } from "./history.ts";
import { createLiveHandle } from "./live.ts";
import { createPublicProducer } from "./public-conversation.ts";
import { AgentClosureError } from "./closure.ts";
import { headExtension, leafScopeExtension } from "./head/tools.ts";
import type { HeadAttachment } from "./head/runtime.ts";
import { submitSchema, type NativeTurn } from "../architecture/types.ts";
import { isConsultation } from "./consultation.ts";
import { ManagedProducer, managedTools, managedGuard } from "./head/managed-tools.ts";

// Pi's default when no setting exists. Host-provided peers need not exist on disk.
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

// A stable registered definition is captured by native wrappers. Authority belongs to
// the originating prompt, never whichever turn happens to be active on this session.
const architectureTurns = new AsyncLocalStorage<{ session: AgentSession; identity: NativeTurn; signal: AbortSignal; active: boolean }>();

const childLifecycles = new WeakMap<AgentSession, { bound: boolean; disposal?: Promise<void>; history?: SessionHistory;
  live?: ReturnType<typeof createLiveHandle>; unbindLive?: () => void;
  head?: HeadAttachment; headBinding?: object; stopAbort?: () => void;
  managed?: ManagedProducer; captureManaged?: (closure?: "released" | "unknown") => void;
  operations: Set<Promise<unknown>>; failures: unknown[]; abort?: Promise<void>; generation: number; closing: boolean }>();

function requestAbort(session: AgentSession): Promise<void> {
  const lifecycle = childLifecycles.get(session)!;
  if (lifecycle.abort) return lifecycle.abort;
  const generation = lifecycle.generation;
  const pending = Promise.resolve().then(() => { if (lifecycle.generation === generation) return session.abort(); });
  lifecycle.abort = pending;
  lifecycle.operations.add(pending);
  void pending.then(() => lifecycle.operations.delete(pending), error => {
    lifecycle.failures.push(error);
    lifecycle.operations.delete(pending);
  });
  return pending;
}

function disposeChildSession(session: AgentSession, signal?: AbortSignal): Promise<void> {
  const lifecycle = childLifecycles.get(session)!;
  if (lifecycle.disposal) return lifecycle.disposal;
  if (signal) {
    lifecycle.stopAbort?.();
    lifecycle.stopAbort = watchAbort(signal, () => { void requestAbort(session).catch(() => {}); });
  }
  lifecycle.closing = true;
  lifecycle.managed?.cancel();
  if (lifecycle.headBinding) lifecycle.head?.unbind(lifecycle.headBinding);
  // Revoke live input synchronously; retain and join its exact close promise below.
  const liveClose = lifecycle.live?.handle.close();
  void liveClose?.catch(() => {});
  lifecycle.disposal = (async () => {
    const failures = lifecycle.failures;
    let shutdownSettled = !lifecycle.bound, disposalSettled = false;
    const joinOperations = async () => {
      while (lifecycle.operations.size) await Promise.allSettled([...lifecycle.operations]);
    };
    await joinOperations();
    const join = async (operation: () => unknown) => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await join(() => lifecycle.managed?.settle());
    await join(() => lifecycle.managed?.assignment.assertHealthy());
    await join(() => lifecycle.captureManaged?.());
    await join(async () => {
      const live = lifecycle.live;
      const captureFailed = (reason: "close_failed" | "capture_failed") => {
        try { live?.handle.onTerminalCaptureFailed?.(reason); } catch { /* Observation cannot obstruct native cleanup. */ }
      };
      try {
        await liveClose;
      } catch (error) {
        captureFailed("close_failed");
        throw error;
      }
      if (live) {
        try {
          const snapshot = live.capture();
          live.handle.onTerminalCapture?.(snapshot);
        } catch { captureFailed("capture_failed"); }
      }
    });
    await join(() => lifecycle.unbindLive?.());
    await join(async () => {
      if (lifecycle.bound) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      shutdownSettled = true;
    });
    await joinOperations();
    await join(async () => {
      await session.dispose();
      disposalSettled = true;
    });
    lifecycle.stopAbort?.();
    await joinOperations();
    let historySettled = false;
    await join(() => {
      lifecycle.history?.disposition(failures.length ? new AgentClosureError([...failures], "SDK session") : undefined);
      historySettled = true;
    });
    await join(async () => {
      // Include native history disposition in the settled head, after all SDK producers.
      await lifecycle.live?.handle.publicConversation?.close(failures.length > 0 || !shutdownSettled || !disposalSettled || !historySettled);
    });
    await join(() => lifecycle.captureManaged?.(failures.length ? "unknown" : "released"));
    if (failures.length) throw new AgentClosureError([...failures], `SDK session ${session.sessionId}`);
    unregisterExecution(session.sessionId);
  })();
  return lifecycle.disposal;
}

/** Omitted reasoning is not forced to medium. Pi keeps its own default. */
export function thinkingLevelFor(reasoning: ReasoningLevel | undefined): ThinkingLevel | undefined {
  return reasoning;
}

type PiFactories = {
  createRuntime: typeof ModelRuntime.create;
  getAgentDir: typeof getAgentDir;
  createSettings: typeof SettingsManager.create;
  createLoader: (options: ConstructorParameters<typeof DefaultResourceLoader>[0]) => DefaultResourceLoader;
  createCodemode: typeof createCodemodeExtension;
  createSession: typeof createAgentSession;
};
const piFactories: PiFactories = {
  createRuntime: options => ModelRuntime.create(options),
  getAgentDir,
  createSettings: (cwd, agentDir) => SettingsManager.create(cwd, agentDir),
  createLoader: options => new DefaultResourceLoader(options),
  createCodemode: createCodemodeExtension,
  createSession: createAgentSession,
};

export function createPiExecutor(options: { now?: () => number; factories?: Partial<PiFactories> } = {}): AttemptExecutor {
  const factories = { ...piFactories, ...options.factories };
  return {
    capturesHistory: true,
    capturesPublicConversation: true,
    async start(input) {
      if (input.head) input = { ...input, signal: AbortSignal.any([input.signal, input.head.signal]) };
      const history = (input.history ?? new InvocationHistory(input.cwd, undefined, input.task, true)).admit(input.instanceId, input.role.id, input.target);
      try {
        // Do not bind the worker abort signal here. The session abort owns cancellation.
        // A signal on runtime create aborts Cursor auth before the child prompt starts.
        const runtime = await factories.createRuntime({ allowModelNetwork: false });
        input.scope?.assertStartup();
        input.consultant?.check();
        const selections = new WeakMap<object, RequestSelection>();
        keepCursorTools(runtime);
        installServiceTierTransport(runtime, selections);
        const result = await runTarget(runtime, selections, options.now ?? (() => performance.now()), input.target, input.task,
          { ...input, sessionHistory: history, factories });
        try {
          return history?.result(result) ?? result;
        } catch (error) {
          await result.session?.dispose();
          throw error;
        }
      } catch (error) {
        history?.result({ status: input.signal.aborted ? "cancelled" : "failed", result: "", error: messageOf(error), sideEffects: false });
        throw error;
      }
    },
  };
}

/** ModelRuntime.streamSimple drops context.tools. Cursor then runs its own shell and that stream does not finish. */
export function cursorProviderContext(model: { provider?: string; api?: string }, context: Context): Context {
  if (model.provider !== "cursor" && model.api !== "cursor-native") return context;
  return { ...normalizeContext(context), tools: context.tools ?? [] };
}

type ServiceTier = "fast" | "priority";

interface RequestSelection {
  model: string;
  reasoning?: string;
  fastRequested: boolean;
  serviceTier?: ServiceTier;
}

function installServiceTierTransport(runtime: ModelRuntime, selections: WeakMap<object, RequestSelection>): void {
  const original = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const selection = selections.get(model);
    if (!selection) return original(model, context, options);
    const onPayload = options?.onPayload;
    const requestOptions = selection.serviceTier
      ? {
          ...options,
          onPayload: async (payload: unknown, providerModel: Model<any>) => {
            const transformed = await onPayload?.(payload, providerModel);
            const body = transformed === undefined ? payload : transformed;
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              throw new Error("unsupported service_tier payload: expected an object");
            }
            return { ...body, service_tier: selection.serviceTier };
          },
        }
      : { ...options };
    return original(model, context, requestOptions);
  };
}

function prepareTargetModel(
  model: Model<any>,
  target: ModelTarget,
  selections: WeakMap<object, RequestSelection>,
): { model?: Model<any>; error?: string } {
  let serviceTier: ServiceTier | undefined;
  if (target.fast === true) {
    if (model.provider === "openai" || model.provider === "openai-codex") {
      serviceTier = "priority";
    } else if (model.provider === "xai" && model.id === "grok-4.7" && model.api === "openai-responses") {
      serviceTier = "priority";
    } else {
      return { error: `fast mode unsupported for ${target.model} (provider ${model.provider}, API ${model.api})` };
    }
  }
  const activated = { ...model };
  selections.set(activated, {
    model: `${model.provider}/${model.id}`,
    reasoning: target.reasoning,
    fastRequested: target.fast === true,
    serviceTier,
  });
  return { model: activated };
}

function recordAppliedReasoning(model: Model<any>, selections: WeakMap<object, RequestSelection>, reasoning: string): void {
  const selection = selections.get(model);
  if (selection) selections.set(model, { ...selection, reasoning });
}

function configurationFailure(error: string, sideEffects: boolean, session?: Attempt["session"]): Attempt {
  return { status: "failed", result: "", error, failureKind: "configuration", sideEffects, session };
}

function keepCursorTools(runtime: ModelRuntime): void {
  const original = runtime.streamSimple.bind(runtime);
  const prepare = (runtime as unknown as {
    prepareRequest(model: Model<any>, options: unknown): Promise<{
      provider: { streamSimple(model: Model<any>, context: Context, options: unknown): AsyncIterable<AssistantMessageEvent> };
      model: Model<any>;
      options: unknown;
    }>;
  }).prepareRequest.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    if (model.provider !== "cursor" && model.api !== "cursor-native") return original(model, context, options);
    const transcript = cursorProviderContext(model, context);
    return lazyStream(model, async () => {
      const prepared = await prepare(model, options);
      return prepared.provider.streamSimple(prepared.model, transcript, prepared.options);
    });
  };
}

/** Cursor-native exec emits no Pi tool event. Missing provider does not throw. */
export function cursorStreamHold(session: {
  model?: { provider?: string } | null;
  isStreaming?: boolean;
}): { name: string } | undefined {
  if (session.model?.provider === "cursor" && session.isStreaming) return { name: "cursor-native" };
  return undefined;
}

async function runTarget(
  runtime: ModelRuntime,
  selections: WeakMap<object, RequestSelection>,
  now: () => number,
  target: ModelTarget,
  prompt: string,
  input: {
    instanceId: string;
    turnId?: string;
    attemptId?: string;
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    bindLive?: Parameters<AttemptExecutor["start"]>[0]["bindLive"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    consultant?: Parameters<AttemptExecutor["start"]>[0]["consultant"];
    participant?: Parameters<AttemptExecutor["start"]>[0]["participant"];
    head?: HeadAttachment;
    sessionHistory?: SessionHistory;
    factories: PiFactories;
  },
  existing?: { session: AgentSession; mode: "pre-prompt" | "continuation" | "turn" },
): Promise<Attempt> {
  const continuation = existing !== undefined && existing.mode !== "pre-prompt";
  const existingHandle = existing && resume(existing.session, runtime, selections, now, input);
  if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: continuation, session: existingHandle };
  const model = findModel(runtime, target.model);
  // Extension providers register during AgentSession bind, not on a fresh runtime.
  if (!model && !existing) return bindThenRun(runtime, selections, now, target, prompt, input);
  if (!model) {
    return target.fast === true
      ? configurationFailure(`fast mode unsupported: model unavailable after provider registration: ${target.model}`, continuation, existingHandle)
      : { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: continuation, session: existingHandle };
  }
  let session = existing?.session;
  if (!session) {
    try {
      session = await openSession(runtime, model, target, input);
    } catch (error) {
      if (error instanceof AgentClosureError) throw error;
      if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
      return { status: "failed", result: "", error: messageOf(error), sideEffects: false };
    }
  }
  const identity: NativeTurn = { instanceId: input.instanceId, turnId: input.turnId!, attemptId: input.attemptId!,
    historyId: input.sessionHistory?.historyId, sessionId: session.sessionId };
  input.participant?.begin(identity);
  const handle = resume(session, runtime, selections, now, input);
  let adjustment: string | undefined, requested = target.reasoning;
  const observed = (attempt: Attempt, requested: ModelTarget["reasoning"], adjustment?: string) => {
    attempt.provenance = { configured: target.configuredReasoning ?? { level: target.reasoning }, selected: target,
      requestedReasoning: requested, activatedModel: session.model && `${session.model.provider}/${session.model.id}`,
      appliedReasoning: attempt.appliedReasoning ?? session.thinkingLevel, adjustment };
    return attempt;
  };
  const beforeDrive = async (result: Attempt): Promise<Attempt> => {
    observed(result, requested, adjustment);
    if (continuation) return { ...result, session: handle };
    await handle.dispose(input.signal);
    return result;
  };
  if (input.signal.aborted) {
    return beforeDrive({ status: "cancelled", result: "cancelled", sideEffects: continuation });
  }
  const operation = childLifecycles.get(session)!;
  operation.generation++;
  operation.abort = undefined;
  const generation = operation.generation;
  const stopWatch = watchAbort(input.signal, () => {
    if (operation.generation === generation) void requestAbort(session).catch(() => {});
  });
  try {
    // Provider registration can replace the runtime model while the session binds.
    const boundModel = findModel(runtime, target.model);
    if (!boundModel) {
      return beforeDrive(target.fast === true
        ? configurationFailure(`fast mode unsupported: model unavailable after provider registration: ${target.model}`, continuation)
        : { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: continuation });
    }
    const activated = prepareTargetModel(boundModel, target, selections);
    if (activated.error) {
      return beforeDrive(configurationFailure(activated.error, continuation));
    }
    const activationError = await activateTarget(session, activated.model!, target);
    if (activationError) {
      return beforeDrive({ status: "failed", result: "", error: activationError, sideEffects: continuation });
    }
    if (target.directReasoning && (!target.reasoning || !session.model ||
        !getSupportedThinkingLevels(session.model).includes(target.reasoning))) {
      return beforeDrive(configurationFailure(`direct reasoning "${target.reasoning}" is not supported by activated model ${session.model?.provider}/${session.model?.id}`, continuation));
    }
    if (target.classifiedReasoning && (!target.reasoning || !session.model ||
        !getSupportedThinkingLevels(session.model).includes(target.reasoning))) {
      adjustment = "classified capability drift; restored frozen configured primary reasoning without reclassification";
      requested = target.classifiedReasoning.configured;
      const restored = { ...target, reasoning: requested };
      const error = await activateTarget(session, activated.model!, restored);
      if (error) return beforeDrive(configurationFailure(error, continuation));
      input.sessionHistory?.append("reasoning-adjustment", { adjustment, selected: target.reasoning,
        configured: target.classifiedReasoning.configured, activatedModel: session.model && `${session.model.provider}/${session.model.id}`,
        appliedReasoning: session.thinkingLevel });
    }
    if (input.signal.aborted || childLifecycles.get(session)?.closing) return beforeDrive({ status: "cancelled", result: "cancelled", sideEffects: continuation });
    try {
      if (session.thinkingLevel) {
        recordAppliedReasoning(activated.model!, selections, session.thinkingLevel);
        input.onActivated?.(session.thinkingLevel);
      }
      // Retire the caller's retained wrapper too: drive can throw before returning a new handle.
      delete handle.retryBeforePrompt;
      const attempt = await drive(session, runtime, selections, now, prompt, input);
      return observed(attempt, requested, adjustment);
    } catch (error) {
      if (error instanceof AgentClosureError) throw error;
      if (!continuation) await handle.dispose(input.signal);
      return { status: "failed", result: "", error: messageOf(error), sideEffects: continuation, session: continuation ? handle : undefined };
    }
  } finally {
    try {
      await childLifecycles.get(session)?.abort?.catch(error => { throw new AgentClosureError([error], `Agent operation ${input.instanceId}`); });
    } finally { stopWatch(); }
  }
}

export async function activateTarget(
  session: {
    setModel(model: NonNullable<ReturnType<ModelRuntime["getModel"]>>, options?: { persist?: boolean }): Promise<void>;
    setThinkingLevel(level: ThinkingLevel): void;
    sessionManager?: AgentSession["sessionManager"];
    model?: AgentSession["model"];
    getAllTools?: AgentSession["getAllTools"];
    setActiveToolsByName?: AgentSession["setActiveToolsByName"];
    settingsManager?: {
      getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined;
      getDefaultThinkingLevel(): ThinkingLevel | undefined;
    };
  },
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  target: ModelTarget,
): Promise<string | undefined> {
  try {
    await session.setModel(model, { persist: false });
    if (session.sessionManager && session.getAllTools && session.setActiveToolsByName) {
      reconcileChildTools({
        sessionManager: session.sessionManager,
        model: session.model,
        getAllTools: () => session.getAllTools!(),
        setActiveToolsByName: (names) => session.setActiveToolsByName!(names),
      });
    }
    // setModel keeps the previous level when settings have no default.
    const settings = session.settingsManager;
    session.setThinkingLevel(
      thinkingLevelFor(target.reasoning)
        ?? settings?.getModelThinkingLevel(model.provider, model.id)
        ?? settings?.getDefaultThinkingLevel()
        ?? DEFAULT_THINKING_LEVEL,
    );
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}

async function bindThenRun(
  runtime: ModelRuntime,
  selections: WeakMap<object, RequestSelection>,
  now: () => number,
  target: ModelTarget,
  prompt: string,
  input: {
    instanceId: string;
    turnId?: string;
    attemptId?: string;
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    bindLive?: Parameters<AttemptExecutor["start"]>[0]["bindLive"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    consultant?: Parameters<AttemptExecutor["start"]>[0]["consultant"];
    participant?: Parameters<AttemptExecutor["start"]>[0]["participant"];
    head?: HeadAttachment;
    sessionHistory?: SessionHistory;
    factories: PiFactories;
  },
): Promise<Attempt> {
  let session: AgentSession;
  try {
    session = await openSession(runtime, undefined, target, input);
  } catch (error) {
    if (error instanceof AgentClosureError) throw error;
    if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
    return { status: "failed", result: "", error: messageOf(error), sideEffects: false };
  }
  const handle = resume(session, runtime, selections, now, input);
  try {
    const result = await runTarget(runtime, selections, now, target, prompt, input, { session, mode: "pre-prompt" });
    if (!result.session) await handle.dispose(input.signal);
    return result;
  } catch (error) {
    await handle.dispose(input.signal);
    throw error;
  }
}

async function openSession(
  runtime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>> | undefined,
  target: ModelTarget,
  input: { instanceId: string; role: Parameters<AttemptExecutor["start"]>[0]["role"]; cwd: string; sessionHistory?: SessionHistory; factories: PiFactories;
    signal: AbortSignal; head?: HeadAttachment; scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    consultant?: Parameters<AttemptExecutor["start"]>[0]["consultant"];
    participant?: Parameters<AttemptExecutor["start"]>[0]["participant"];
    bindLive?: Parameters<AttemptExecutor["start"]>[0]["bindLive"] },
): Promise<AgentSession> {
  const agentDir = input.factories.getAgentDir();
  const settingsManager = input.factories.createSettings(input.cwd, agentDir);
  const allowed = new Set(skillNamesForRole(input.role));
  let live: ReturnType<typeof createLiveHandle> | undefined;
  let nativeSession: AgentSession | undefined;
  const headBinding = input.head?.bind(input.instanceId);
  const managedAssignment = input.head?.managed ?? input.scope?.managed ?? input.consultant?.managed;
  const supported = new Set<string>();
  const managed = managedAssignment ? new ManagedProducer(managedAssignment, {
    writes: input.head ? input.head.dag!.graph.envelope : input.scope?.originalWrites ?? input.consultant!.writes,
    check: () => {
      if (!nativeSession) throw new Error("managed native session not bound");
      if (input.head) {
        input.head.check(headBinding!);
        if (!input.head.dag!.codingAllowed(headBinding!)) throw new Error("Head coding requires the exclusive integration barrier");
        return input.head.dag!.graph.revision;
      }
      return input.scope ? input.scope.checkManaged(nativeSession.sessionId) : input.consultant!.check();
    },
    effects: () => input.head?.admitted(),
    source: () => ({ kind: input.head ? "head" : input.scope ? "leaf" : "consultation", instanceId: input.instanceId,
      groupId: input.sessionHistory!.invocation.group.groupId, historyId: input.sessionHistory!.historyId,
      sessionId: nativeSession!.sessionId, ...(input.scope ? { runId: input.scope.runId } : {}), ...(input.consultant ? { dispatchId: input.consultant.dispatchId } : {}) }),
  }, input.signal) : undefined;
  const loader = input.factories.createLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [packageRoot()],
    extensionFactories: [input.factories.createCodemode({ mode: "on" }), pi => {
      pi.on("tool_call", event => {
        if ((isConsultation(input.role.id) || input.participant) && (isOrchestrationTool(event.toolName) || input.participant && ["edit", "write", "apply_patch", "lsp_rename"].includes(event.toolName)))
          return { block: true, reason: "Consultative leaves cannot orchestrate Pitako work" };
      });
      if (input.participant) {
        pi.registerTool({ name: "architecture_submit", label: "Submit architecture turn", description: "Submit for your exact architecture grant. Contextual errors allow one correction with a new submissionId (two distinct candidates). Identical retries are idempotent; valid provisional submissions are locked. Does not dispatch work.",
          parameters: submitSchema, async execute(id, value, signal, _update, ctx) {
            try {
              const turn = architectureTurns.getStore();
              if (!turn?.active || turn.session !== nativeSession) throw new Error("architecture grant not active");
              input.participant!.attemptSubmit(turn.identity);
              if (turn.signal.aborted || signal?.aborted || childLifecycles.get(turn.session)?.closing)
                throw new Error("architecture grant not active");
              const receipt = input.participant!.submit(id, value, ctx, turn.identity);
              return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
            } catch (error) {
              const details = error instanceof SubmissionError ? error.diagnostic : {};
              return { content: [{ type: "text", text: String(error) }], details, isError: true };
            }
          } });
        pi.on("session_start", (_event, ctx) => input.participant!.bind(pi, ctx));
      }
      pi.on("turn_start", () => { guardConsultationTools(); if (nativeSession) reconcileChildTools(nativeSession); live?.open(); });
      pi.on("agent_before_settle", () => input.head ? undefined : live?.settle());
      pi.on("agent_settled", () => live?.settle());
      pi.on("session_tree", event => live?.handle.publicConversation?.reconcile(event.oldLeafId));
      pi.on("session_start", () => live?.handle.publicConversation?.reconcile());
      pi.on("session_compact", () => live?.handle.publicConversation?.reconcile());
    }, ...(input.head && headBinding ? [headExtension(input.head, headBinding, () => nativeSession!.sessionManager)] : []),
    ...(input.scope ? [leafScopeExtension(input.scope, () => nativeSession!)] : []),
    ...(managed ? [managedGuard(supported, !!input.head)] : [])],
    appendSystemPrompt: [childInstructions(input.role, input.instanceId), ...(input.participant ? ["Host architecture policy: analysis only; no product edits, including through Bash. Use only your local architecture_submit grant. Do not dispatch agents or use coordinator tools. Bash remains a trusted tool, not an OS sandbox."] : []), ...(managed ? [
      "Managed local-source support: use the supported native file tools, known loaded apply_patch, or finite foreground bash within your canonical write reservation. No daemons, detached/remote writers or escaped descendants. Shell scope is cooperative, not confinement. Unsupported writing tools and unowned compositions are refused. Only the host-bound Head requests staging through head_checkpoint; leaves do not stage or commit independently. A checkpoint is local partial source, not acceptance, publication or final verification.",
    ] : [])],
    skillsOverride: (base) => ({
      skills: base.skills.filter((skill) => allowed.has(skill.name)),
      diagnostics: base.diagnostics,
    }),
  });
  await loader.reload();
  input.scope?.assertStartup();
  input.consultant?.check();
  if (input.signal.aborted) throw new Error("Agent session startup cancelled");
  // Codemode can invoke a registered definition without a top-level tool_call event.
  function guardConsultationTools() {
    if (!isConsultation(input.role.id) && !input.participant) return;
    for (const extension of loader.getExtensions().extensions) {
      for (const [name, tool] of extension.tools) if (isOrchestrationTool(name) || input.participant && ["edit", "write", "apply_patch", "lsp_rename"].includes(name)) {
        tool.definition = { ...tool.definition, async execute() {
          return { content: [{ type: "text", text: "Consultative leaves cannot orchestrate Pitako work" }], details: {}, isError: true };
        } };
      }
    }
  }
  guardConsultationTools();
  const customTools = managed ? managedTools(loader, managed) : undefined;
  for (const definition of customTools ?? []) supported.add(definition.name);
  const thinkingLevel = model ? thinkingLevelFor(target.reasoning) : undefined;
  const { session } = await input.factories.createSession({
    cwd: input.cwd,
    agentDir,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    sessionManager: input.sessionHistory!.create(),
    settingsManager,
    resourceLoader: loader,
    modelRuntime: runtime,
    excludeTools: [...ORCHESTRATION_TOOLS],
    ...(customTools ? { customTools } : {}),
  });
  nativeSession = session;
  const lifecycle: NonNullable<ReturnType<typeof childLifecycles.get>> = {
    bound: false, history: input.sessionHistory, head: input.head, headBinding, managed, operations: new Set(), failures: [], generation: 0, closing: false,
  };
  if (managed) {
    // Capture native IDs before retirement, never infer them from tool events/results text.
    const identity = () => ({ kind: input.head ? "head" as const : input.scope ? "leaf" as const : "consultation" as const, instanceId: input.instanceId,
      groupId: input.sessionHistory!.invocation.group.groupId, historyId: input.sessionHistory!.historyId,
      sessionId: session.sessionId, observedRevision: input.head ? input.head.dag!.graph.revision : input.scope?.effectiveRevision ?? input.consultant!.observedRevision,
      ...(input.scope ? { runId: input.scope.runId } : {}), ...(input.consultant ? { dispatchId: input.consultant.dispatchId } : {}) });
    lifecycle.captureManaged = closure => {
      if (closure) managedAssignment!.closed(input.sessionHistory!.historyId, closure);
      else managedAssignment!.capture(identity(), session.sessionManager.getBranch());
    };
    if (input.head) input.head.bindCheckpointCapture(() => {
      managedAssignment!.capture(identity(), session.sessionManager.getBranch());
      return identity();
    });
  }
  childLifecycles.set(session, lifecycle);
  lifecycle.stopAbort = watchAbort(input.signal, () => {
    managed?.cancel();
    input.head?.revoke();
    void lifecycle.live?.handle.close().catch(error => lifecycle.failures.push(error));
    void requestAbort(session).catch(() => {});
  });
  try {
    const manager = session.sessionManager;
    input.consultant?.bindNative(() => {
      if (session.sessionManager !== manager) throw new Error("consultation native SessionManager replaced");
      return JSON.stringify([session.sessionId, manager.getSessionId(), manager.getSessionFile()]);
    });
    input.scope?.assertStartup();
    input.consultant?.check();
    lifecycle.history?.attached();
    if (input.scope && input.sessionHistory) {
      input.scope.bindRevision(revision => input.sessionHistory!.headRevision(revision));
    }
    registerExecution({ instanceId: input.instanceId, roleId: input.role.id, sessionId: session.sessionId,
      profile: isConsultation(input.role.id) || input.participant ? "analysis" : "coding",
      architecture: !!input.participant,
      managed: input.head ? "head" : input.scope ? "leaf" : input.consultant ? "consultation" : undefined });
    if (input.signal.aborted) {
      await disposeChildSession(session);
      throw new Error("Agent session startup cancelled");
    }
    live = input.bindLive ? createLiveHandle(session, input.sessionHistory!, () => input.head?.interruptWait()) : undefined;
    if (live && input.participant) live.handle.input = async () => { throw new Error("Use architecture_control for architecture participants"); };
    lifecycle.live = live;
    if (live) live.handle.publicConversation = createPublicProducer(session, input.sessionHistory!);
    lifecycle.unbindLive = live ? input.bindLive!(live.handle) : undefined;
    if (live) session.subscribe(event => {
      live!.event(event);
      live!.handle.publicConversation?.event(event);
    });
    if (lifecycle.history) session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") lifecycle.history!.assistantObserved();
    });
    if (input.signal.aborted) {
      await disposeChildSession(session);
      throw new Error("Agent session startup cancelled");
    }
    await session.bindExtensions({});
    lifecycle.bound = true;
    guardConsultationTools();
    input.scope?.assertStartup();
    input.consultant?.check();
    reconcileChildTools(session);
    lifecycle.stopAbort?.();
    lifecycle.stopAbort = undefined;
    return session;
  } catch (error) {
    await disposeChildSession(session);
    throw error;
  }
}

async function drive(
  session: AgentSession,
  runtime: ModelRuntime,
  selections: WeakMap<object, RequestSelection>,
  now: () => number,
  prompt: string,
  input: {
    instanceId: string;
    turnId?: string;
    attemptId?: string;
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: (event: { type?: string; toolName?: string; assistantMessageEvent?: { type?: string } }) => void;
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    consultant?: Parameters<AttemptExecutor["start"]>[0]["consultant"];
    participant?: Parameters<AttemptExecutor["start"]>[0]["participant"];
    factories: PiFactories;
    head?: HeadAttachment;
  },
): Promise<Attempt> {
  // continueWith skips executor.start. The probe closes over this session only.
  const operation = childLifecycles.get(session)!;
  input.bindActivityProbe?.(() => cursorStreamHold(session));
  try {
    let sideEffects = false;
    const tools: Record<string, number> = {};
    const requests: AgentRequestObservation[] = [];
    let activeRequest: { observation: AgentRequestObservation; startedAt: number } | undefined;
    const finishRequest = (reason: "cancelled" | "failed") => {
      if (!activeRequest) return;
      if (activeRequest.observation.time_to_first_model_output_ms === "unavailable") {
        activeRequest.observation.time_to_first_model_output_unavailable_reason = reason;
      }
      activeRequest = undefined;
    };
    const originalStreamFunction = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      if (options?.sessionId !== undefined && options.sessionId !== session.sessionId) {
        return originalStreamFunction(model, context, options);
      }
      const selection = selections.get(model);
      const history = childLifecycles.get(session)?.history;
      history?.instructions(getCurrentSystemPrompt(context.messages), getCurrentSystemPrompt(
        session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" ? [entry.message] : []),
      ));
      history?.append("selection", {
        model: `${model.provider}/${model.id}`, requested: selection,
        appliedReasoning: options?.reasoning, continuation: session.messages.some((message) => message.role === "assistant"),
      });
      const observation: AgentRequestObservation = {
        model: `${model.provider}/${model.id}`,
        reasoning: options?.reasoning,
        historyId: history?.historyId,
        sessionId: session.sessionId,
        sdkOptions: {
          reasoning: options?.reasoning,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        },
        fast_requested: selection?.fastRequested ?? false,
        ...(selection?.serviceTier ? { requested_service_tier: selection.serviceTier } : {}),
        returned_service_tier: "unavailable",
        time_to_first_model_output_ms: "unavailable",
      };
      const request = { observation, startedAt: now() };
      requests.push(observation);
      try { input.onRequest?.(observation); } catch { /* Observers cannot change a request. */ }
      activeRequest = request;
      return lazyStream(model, async () => {
        try {
          return await originalStreamFunction(model, context, options);
        } catch (error) {
          if (activeRequest === request) finishRequest("failed");
          throw error;
        }
      });
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && activeRequest && activeRequest.observation.time_to_first_model_output_ms === "unavailable" && hasFirstModelOutput(event.assistantMessageEvent)) {
        activeRequest.observation.time_to_first_model_output_ms = Math.max(0, now() - activeRequest.startedAt);
        delete activeRequest.observation.time_to_first_model_output_unavailable_reason;
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        finishRequest(event.message.stopReason === "aborted" ? "cancelled" : "failed");
      }
      input.onActivity?.(event);
      if (event.type === "tool_execution_start") {
        if (marksSideEffect(event.toolName)) sideEffects = true;
      }
      if (event.type === "tool_execution_end") {
        tools[event.toolName] = (tools[event.toolName] ?? 0) + 1;
      }
    });
    const handle = resume(session, runtime, selections, now, input);
    const before = usageFrom(session, {});
    const usage = () => attemptUsage(before, session, tools, Boolean(input.turnId || input.head || input.scope || isConsultation(input.role.id)));
    if (input.signal.aborted) {
      try {
        await requestAbort(session);
      } finally {
        unsubscribe();
        session.agent.streamFunction = originalStreamFunction;
      }
      return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: usage(), session: handle };
    }
    try {
      const lifecycle = childLifecycles.get(session)!;
      if (lifecycle.closing) throw new Error("Agent session is closing");
      const prompting = Promise.resolve().then(() => {
        if (input.signal.aborted || lifecycle.closing) return;
        const identity: NativeTurn = { instanceId: input.instanceId, turnId: input.turnId!, attemptId: input.attemptId!,
          historyId: lifecycle.history?.historyId, sessionId: session.sessionId };
        input.participant?.prompt(identity);
        input.scope?.beginPrompt(session.sessionId);
        input.consultant?.beginPrompt();
        if (!input.participant) return session.prompt(prompt, { expandPromptTemplates: false });
        const turn = { session, identity, signal: input.signal, active: true };
        return architectureTurns.run(turn, async () => {
          try { await session.prompt(prompt, { expandPromptTemplates: false }); }
          finally { turn.active = false; }
        });
      });
      lifecycle.operations.add(prompting);
      try { await prompting; } finally { lifecycle.operations.delete(prompting); }
      const assistant = lastAssistant(session);
      if (input.signal.aborted) {
        return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: usage(), appliedReasoning: session.thinkingLevel, session: handle };
      }
      if (assistant?.stopReason === "aborted" || assistant?.stopReason === "error") {
        return failedAttempt(assistant.errorMessage ?? assistant.stopReason ?? "provider error", sideEffects, handle, session, usage(), requests);
      }
      return {
        status: "completed",
        result: textOf(assistant),
        sideEffects,
        requests: requests.length ? requests : undefined,
        usage: usage(),
        appliedReasoning: session.thinkingLevel,
        session: handle,
      };
    } catch (error) {
      if (input.signal.aborted) {
        return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: usage(), session: handle };
      }
      return failedAttempt(messageOf(error), sideEffects, handle, session, usage(), requests);
    } finally {
      try {
        childLifecycles.get(session)?.captureManaged?.();
        await childLifecycles.get(session)?.live?.settle();
        await operation.abort;
      } finally {
        finishRequest(input.signal.aborted ? "cancelled" : "failed");
        unsubscribe();
        session.agent.streamFunction = originalStreamFunction;
      }
    }
  } finally {
    input.bindActivityProbe?.(undefined);
  }
}

function failedAttempt(
  error: string,
  sideEffects: boolean,
  handle: NonNullable<Attempt["session"]>,
  session: AgentSession,
  usage: AgentUsage | undefined,
  requests: AgentRequestObservation[],
): Attempt {
  return {
    status: "failed",
    result: "",
    error,
    failureKind: isServiceTierRejection(error) ? "configuration" : undefined,
    sideEffects,
    requests: requests.length ? requests : undefined,
    usage,
    appliedReasoning: session.thinkingLevel,
    session: handle,
  };
}

function resume(
  session: AgentSession,
  runtime: ModelRuntime,
  selections: WeakMap<object, RequestSelection>,
  now: () => number,
  input: {
    instanceId: string;
    turnId?: string;
    attemptId?: string;
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    consultant?: Parameters<AttemptExecutor["start"]>[0]["consultant"];
    participant?: Parameters<AttemptExecutor["start"]>[0]["participant"];
    factories: PiFactories;
    head?: HeadAttachment;
  },
): NonNullable<Attempt["session"]> {
  const history = childLifecycles.get(session)?.history;
  return {
    async turn(turn) {
      history?.append("turn", { turnId: turn.turnId, attemptId: turn.attemptId, task: turn.task, target: turn.target });
      const result = await runTarget(runtime, selections, now, turn.target, turn.task,
        { ...input, ...turn, sessionHistory: history }, { session, mode: "turn" });
      return history?.result(result) ?? result;
    },
    async continueWith(target, note, signal, operation) {
      history?.append("continuation", { target, note });
      const result = await runTarget(runtime, selections, now, target, note, { ...input, ...operation, signal, sessionHistory: history }, { session, mode: "continuation" });
      return history?.result(result) ?? result;
    },
    async dispose(signal) {
      await disposeChildSession(session, signal);
    },
  };
}

function findModel(runtime: ModelRuntime, ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  return runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1));
}

function hasFirstModelOutput(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const value = event as {
    type?: string;
    delta?: unknown;
    contentIndex?: number;
    partial?: { content?: Array<{ type?: string; id?: string; name?: string }> };
  };
  if ((value.type === "text_delta" || value.type === "thinking_delta") && typeof value.delta === "string" && value.delta.length > 0) {
    return true;
  }
  if (value.type !== "toolcall_start" || !Number.isInteger(value.contentIndex)) return false;
  const call = value.partial?.content?.[value.contentIndex!];
  return call?.type === "toolCall" && Boolean(call.id && call.name);
}

function lastAssistant(session: AgentSession): { stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> } | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index] as { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> };
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function textOf(message: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  const parts = message?.content ?? [];
  const text = parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim();
  return text.length > 0 ? text : "(no final result)";
}

export function watchAbort(signal: AbortSignal, onAbort: () => void): () => void {
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  const listener = () => onAbort();
  signal.addEventListener("abort", listener, { once: true });
  if (signal.aborted) {
    signal.removeEventListener("abort", listener);
    onAbort();
    return () => {};
  }
  return () => signal.removeEventListener("abort", listener);
}

function attemptUsage(before: AgentUsage, session: AgentSession, tools: Record<string, number>, preserveUnknown: boolean): AgentUsage | undefined {
  const delta = usageDelta(before, usageFrom(session, {}), preserveUnknown);
  if (!delta) return undefined;
  return { ...delta, tools, contextTokens: usageFrom(session, {}).contextTokens };
}

function usageFrom(session: AgentSession, tools: Record<string, number>): AgentUsage {
  const stats = session.getSessionStats();
  const contextTokens = stats.contextUsage?.tokens ?? undefined;
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    tools,
    contextTokens: contextTokens ?? undefined,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
