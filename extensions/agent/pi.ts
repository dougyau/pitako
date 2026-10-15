import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, lazyStream, normalizeContext, type AssistantMessageEvent, type Context, type Model } from "@earendil-works/pi-ai";
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
import { reconcileChildTools, ORCHESTRATION_TOOLS } from "../profile.ts";
import { packageRoot } from "../stack.ts";
import { marksSideEffect } from "./effects.ts";
import { isServiceTierRejection } from "./fallback.ts";
import { childInstructions, skillNamesForRole, usageDelta, type AgentRequestObservation, type AgentUsage, type Attempt, type AttemptExecutor } from "./run.ts";
import type { ModelTarget, ReasoningLevel } from "../roles/types.ts";
import { InvocationHistory, type SessionHistory } from "./history.ts";
import { createLiveHandle } from "./live.ts";
import { createPublicProducer } from "./public-conversation.ts";
import { AgentClosureError } from "./closure.ts";
import { headExtension, leafScopeExtension } from "./head/tools.ts";
import type { HeadAttachment } from "./head/runtime.ts";

// Package entry does not re-export this. Import the file next to the resolved entry.
export let DEFAULT_THINKING_LEVEL: ThinkingLevel;
const sdkDefaultsReady = import(
  new URL("./core/defaults.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
).then((defaults: { DEFAULT_THINKING_LEVEL: ThinkingLevel }) => {
  DEFAULT_THINKING_LEVEL = defaults.DEFAULT_THINKING_LEVEL;
  return defaults;
});

const childLifecycles = new WeakMap<AgentSession, { bound: boolean; disposal?: Promise<void>; history?: SessionHistory;
  live?: ReturnType<typeof createLiveHandle>; unbindLive?: () => void;
  head?: HeadAttachment; headBinding?: object; stopAbort?: () => void;
  operations: Set<Promise<unknown>>; failures: unknown[]; abort?: Promise<void>; closing: boolean }>();

function requestAbort(session: AgentSession): Promise<void> {
  const lifecycle = childLifecycles.get(session)!;
  if (lifecycle.abort) return lifecycle.abort;
  const pending = Promise.resolve().then(() => session.abort());
  lifecycle.abort = pending;
  lifecycle.operations.add(pending);
  void pending.then(() => lifecycle.operations.delete(pending), error => {
    lifecycle.failures.push(error);
    lifecycle.operations.delete(pending);
  });
  return pending;
}

function disposeChildSession(session: AgentSession): Promise<void> {
  const lifecycle = childLifecycles.get(session)!;
  if (lifecycle.disposal) return lifecycle.disposal;
  lifecycle.closing = true;
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
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    bindLive?: Parameters<AttemptExecutor["start"]>[0]["bindLive"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    head?: HeadAttachment;
    sessionHistory?: SessionHistory;
    factories: PiFactories;
  },
  existing?: { session: AgentSession; mode: "pre-prompt" | "continuation" },
): Promise<Attempt> {
  const continuation = existing?.mode === "continuation";
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
  const handle = resume(session, runtime, selections, now, input);
  const beforeDrive = async (result: Attempt): Promise<Attempt> => {
    if (continuation) return { ...result, session: handle };
    await handle.dispose();
    return result;
  };
  if (input.signal.aborted) {
    return beforeDrive({ status: "cancelled", result: "cancelled", sideEffects: continuation });
  }
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
  try {
    if (session.thinkingLevel) {
      recordAppliedReasoning(activated.model!, selections, session.thinkingLevel);
      input.onActivated?.(session.thinkingLevel);
    }
    // Retire the caller's retained wrapper too: drive can throw before returning a new handle.
    delete handle.retryBeforePrompt;
    return await drive(session, runtime, selections, now, prompt, input);
  } catch (error) {
    if (error instanceof AgentClosureError) throw error;
    if (!continuation) await handle.dispose();
    return { status: "failed", result: "", error: messageOf(error), sideEffects: continuation, session: continuation ? handle : undefined };
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
    const defaults = await sdkDefaultsReady;
    // setModel keeps the previous level when settings have no default.
    const settings = session.settingsManager;
    session.setThinkingLevel(
      thinkingLevelFor(target.reasoning)
        ?? settings?.getModelThinkingLevel(model.provider, model.id)
        ?? settings?.getDefaultThinkingLevel()
        ?? defaults.DEFAULT_THINKING_LEVEL,
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
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    bindLive?: Parameters<AttemptExecutor["start"]>[0]["bindLive"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
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
    if (!result.session) await handle.dispose();
    return result;
  } catch (error) {
    await handle.dispose();
    throw error;
  }
}

async function openSession(
  runtime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>> | undefined,
  target: ModelTarget,
  input: { instanceId: string; role: Parameters<AttemptExecutor["start"]>[0]["role"]; cwd: string; sessionHistory?: SessionHistory; factories: PiFactories;
    signal: AbortSignal; head?: HeadAttachment; scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    bindLive?: Parameters<AttemptExecutor["start"]>[0]["bindLive"] },
): Promise<AgentSession> {
  const agentDir = input.factories.getAgentDir();
  const settingsManager = input.factories.createSettings(input.cwd, agentDir);
  const allowed = new Set(skillNamesForRole(input.role));
  let live: ReturnType<typeof createLiveHandle> | undefined;
  let nativeSession: AgentSession | undefined;
  const headBinding = input.head?.bind(input.instanceId);
  const loader = input.factories.createLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [packageRoot()],
    extensionFactories: [input.factories.createCodemode({ mode: "on" }), pi => {
      pi.on("turn_start", () => { live?.open(); });
      pi.on("agent_before_settle", () => live?.settle());
      pi.on("session_tree", event => live?.handle.publicConversation?.reconcile(event.oldLeafId));
      pi.on("session_start", () => live?.handle.publicConversation?.reconcile());
      pi.on("session_compact", () => live?.handle.publicConversation?.reconcile());
    }, ...(input.head && headBinding ? [headExtension(input.head, headBinding, () => nativeSession!.sessionManager)] : []),
    ...(input.scope ? [leafScopeExtension(input.scope, () => nativeSession!)] : [])],
    appendSystemPrompt: [childInstructions(input.role, input.instanceId)],
    skillsOverride: (base) => ({
      skills: base.skills.filter((skill) => allowed.has(skill.name)),
      diagnostics: base.diagnostics,
    }),
  });
  await loader.reload();
  input.scope?.assertStartup();
  if (input.signal.aborted) throw new Error("Agent session startup cancelled");
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
  });
  nativeSession = session;
  const lifecycle: NonNullable<ReturnType<typeof childLifecycles.get>> = {
    bound: false, history: input.sessionHistory, head: input.head, headBinding, operations: new Set(), failures: [], closing: false,
  };
  childLifecycles.set(session, lifecycle);
  lifecycle.stopAbort = watchAbort(input.signal, () => {
    input.head?.revoke();
    void lifecycle.live?.handle.close().catch(error => lifecycle.failures.push(error));
    void requestAbort(session).catch(() => {});
  });
  try {
    input.scope?.assertStartup();
    lifecycle.history?.attached();
    if (input.scope && input.sessionHistory) {
      input.scope.bindRevision(revision => input.sessionHistory!.headRevision(revision));
    }
    registerExecution({ instanceId: input.instanceId, roleId: input.role.id, sessionId: session.sessionId });
    if (input.signal.aborted) {
      await disposeChildSession(session);
      throw new Error("Agent session startup cancelled");
    }
    live = input.bindLive ? createLiveHandle(session, input.sessionHistory!) : undefined;
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
    input.scope?.assertStartup();
    reconcileChildTools(session);
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
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: (event: { type?: string; toolName?: string; assistantMessageEvent?: { type?: string } }) => void;
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    factories: PiFactories;
    head?: HeadAttachment;
  },
): Promise<Attempt> {
  // continueWith skips executor.start. The probe closes over this session only.
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
    const usage = () => attemptUsage(before, session, tools, Boolean(input.head || input.scope));
    if (input.signal.aborted) {
      try {
        await requestAbort(session);
      } finally {
        unsubscribe();
        session.agent.streamFunction = originalStreamFunction;
      }
      return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: usage(), session: handle };
    }
    const stopWatch = watchAbort(input.signal, () => { void requestAbort(session).catch(() => {}); });
    try {
      const lifecycle = childLifecycles.get(session)!;
      if (lifecycle.closing) throw new Error("Agent session is closing");
      const prompting = Promise.resolve().then(() => {
        if (input.signal.aborted || lifecycle.closing) return;
        input.scope?.beginPrompt(session.sessionId);
        return session.prompt(prompt, { expandPromptTemplates: false });
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
      await childLifecycles.get(session)?.live?.settle();
      finishRequest(input.signal.aborted ? "cancelled" : "failed");
      stopWatch();
      unsubscribe();
      session.agent.streamFunction = originalStreamFunction;
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
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    onRequest?: (request: AgentRequestObservation) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
    scope?: Parameters<AttemptExecutor["start"]>[0]["scope"];
    factories: PiFactories;
    head?: HeadAttachment;
  },
): NonNullable<Attempt["session"]> {
  const history = childLifecycles.get(session)?.history;
  return {
    async continueWith(target, note, signal) {
      history?.append("continuation", { target, note });
      const result = await runTarget(runtime, selections, now, target, note, { ...input, signal, sessionHistory: history }, { session, mode: "continuation" });
      return history?.result(result) ?? result;
    },
    async dispose() {
      await disposeChildSession(session);
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
