import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { lazyStream, normalizeContext, type AssistantMessageEvent, type Context, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerExecution, unregisterExecution } from "../execution-identity.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../profile.ts";
import { marksSideEffect } from "./effects.ts";
import { isServiceTierRejection } from "./fallback.ts";
import { childInstructions, skillNamesForRole, usageDelta, type AgentRequestObservation, type AgentUsage, type Attempt, type AttemptExecutor } from "./run.ts";
import { completeTool, emptyCodeIntelligenceUsage, isDenseToolName, type CodeIntelligenceUsage, type DenseCallUsage, type ToolOutcome } from "../code-intelligence/metrics.ts";
import { CODE_INTELLIGENCE_TOOLS } from "../code-intelligence/tools.ts";
import { bindCodeIntelligenceApi } from "../code-intelligence/index.ts";
import codegraphRaw from "../code-intelligence/codegraph-raw.ts";
import lspExtension from "pi-lsp-client/src/index.ts";
import type { ModelTarget, ReasoningLevel } from "../roles/types.ts";

// Package entry does not re-export this. Import the file next to the resolved entry.
export const { DEFAULT_THINKING_LEVEL } = await import(
  new URL("./core/defaults.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
) as { DEFAULT_THINKING_LEVEL: ThinkingLevel };

const navigationWindows = new WeakMap<AgentSession, { remaining: number }>();

function captureExtensionTools(register: (pi: ExtensionAPI) => void): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  register({
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    on() { return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  return tools;
}

const RAW_CHILD_TOOLS = [
  ...captureExtensionTools(lspExtension),
  ...captureExtensionTools(codegraphRaw),
];
export const CHILD_CODE_TOOLS = [...CODE_INTELLIGENCE_TOOLS, ...RAW_CHILD_TOOLS];

/** Omitted reasoning is not forced to medium. Pi keeps its own default. */
export function thinkingLevelFor(reasoning: ReasoningLevel | undefined): ThinkingLevel | undefined {
  return reasoning;
}

export function createPiExecutor(options: { now?: () => number } = {}): AttemptExecutor {
  return {
    async start(input) {
      // Do not bind the worker abort signal here. The session abort owns cancellation.
      // A signal on runtime create aborts Cursor auth before the child prompt starts.
      const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
      const selections = new WeakMap<object, RequestSelection>();
      keepCursorTools(runtime);
      installServiceTierTransport(runtime, selections);
      return runTarget(runtime, selections, options.now ?? (() => performance.now()), input.target, input.task, input);
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
    if (model.provider === "openai-codex" && model.id === "gpt-6-luna" && model.api === "openai-codex-responses") {
      serviceTier = "fast";
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
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
  },
  existing?: AgentSession,
): Promise<Attempt> {
  if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
  const model = findModel(runtime, target.model);
  // Extension providers register during AgentSession bind, not on a fresh runtime.
  if (!model && !existing) return bindThenRun(runtime, selections, now, target, prompt, input);
  if (!model) {
    return target.fast === true
      ? configurationFailure(`fast mode unsupported: model unavailable after provider registration: ${target.model}`, true, resume(existing!, runtime, selections, now, input))
      : { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  let session = existing;
  if (!session) {
    try {
      session = await openSession(runtime, model, target, input);
    } catch (error) {
      if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
      return { status: "failed", result: "", error: messageOf(error), sideEffects: false };
    }
  }
  if (input.signal.aborted) {
    await resume(session, runtime, selections, now, input).dispose();
    return { status: "cancelled", result: "cancelled", sideEffects: false };
  }
  // Provider registration can replace the runtime model while the session binds.
  const boundModel = findModel(runtime, target.model);
  if (!boundModel) {
    const handle = resume(session, runtime, selections, now, input);
    await handle.dispose();
    return target.fast === true
      ? configurationFailure(`fast mode unsupported: model unavailable after provider registration: ${target.model}`, false)
      : { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  const activated = prepareTargetModel(boundModel, target, selections);
  if (activated.error) {
    const handle = resume(session, runtime, selections, now, input);
    if (!existing) await handle.dispose();
    return configurationFailure(activated.error, Boolean(existing), existing ? handle : undefined);
  }
  const activationError = await activateTarget(session, activated.model!, target);
  if (activationError) {
    return { status: "failed", result: "", error: activationError, sideEffects: Boolean(existing), session: resume(session, runtime, selections, now, input) };
  }
  if (session.thinkingLevel) {
    recordAppliedReasoning(activated.model!, selections, session.thinkingLevel);
    input.onActivated?.(session.thinkingLevel);
  }
  return drive(session, runtime, selections, now, prompt, input);
}

export async function activateTarget(
  session: {
    setModel(model: NonNullable<ReturnType<ModelRuntime["getModel"]>>, options?: { persist?: boolean }): Promise<void>;
    setThinkingLevel(level: ThinkingLevel): void;
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
    role: Parameters<AttemptExecutor["start"]>[0]["role"];
    cwd: string;
    signal: AbortSignal;
    onActivity?: Parameters<AttemptExecutor["start"]>[0]["onActivity"];
    onActivated?: (appliedReasoning: string) => void;
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
  },
): Promise<Attempt> {
  let session: AgentSession;
  try {
    session = await openSession(runtime, undefined, target, input);
  } catch (error) {
    if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
    return { status: "failed", result: "", error: messageOf(error), sideEffects: false };
  }
  const handle = () => resume(session, runtime, selections, now, input);
  if (input.signal.aborted) {
    await handle().dispose();
    return { status: "cancelled", result: "cancelled", sideEffects: false };
  }
  const model = findModel(runtime, target.model);
  if (!model) {
    await handle().dispose();
    return target.fast === true
      ? configurationFailure(`fast mode unsupported: model unavailable after provider registration: ${target.model}`, false)
      : { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  const activated = prepareTargetModel(model, target, selections);
  if (activated.error) {
    await handle().dispose();
    return configurationFailure(activated.error, false);
  }
  const activationError = await activateTarget(session, activated.model!, target);
  if (activationError) {
    await handle().dispose();
    return { status: "failed", result: "", error: activationError, sideEffects: false };
  }
  if (session.thinkingLevel) {
    recordAppliedReasoning(activated.model!, selections, session.thinkingLevel);
    input.onActivated?.(session.thinkingLevel);
  }
  return drive(session, runtime, selections, now, prompt, input);
}

async function openSession(
  runtime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>> | undefined,
  target: ModelTarget,
  input: { instanceId: string; role: Parameters<AttemptExecutor["start"]>[0]["role"]; cwd: string },
): Promise<AgentSession> {
  const agentDir = getAgentDir();
  bindCodeIntelligenceApi();
  const settingsManager = SettingsManager.create(input.cwd, agentDir);
  const allowed = new Set(skillNamesForRole(input.role));
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: [childInstructions(input.role, input.instanceId)],
    skillsOverride: (base) => ({
      skills: base.skills.filter((skill) => allowed.has(skill.name)),
      diagnostics: base.diagnostics,
    }),
  });
  await loader.reload();
  const childTools = [...CHILD_CODE_TOOLS];
  const thinkingLevel = model ? thinkingLevelFor(target.reasoning) : undefined;
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader: loader,
    customTools: childTools,
    modelRuntime: runtime,
    excludeTools: [...ORCHESTRATION_TOOLS],
  });
  session.setActiveToolsByName(childActiveTools(session.getAllTools().map((tool) => tool.name), process.platform, input.role.id));
  registerExecution({ instanceId: input.instanceId, roleId: input.role.id, sessionId: session.sessionId });
  return session;
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
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
  },
): Promise<Attempt> {
  // continueWith skips executor.start. The probe closes over this session only.
  input.bindActivityProbe?.(() => cursorStreamHold(session));
  try {
    let sideEffects = false;
    const tools: Record<string, number> = {};
    const codeIntelligence = emptyCodeIntelligenceUsage();
    const navigation = navigationWindows.get(session) ?? { remaining: 0 };
    codeIntelligence.navigation.remaining = navigation.remaining;
    const toolStarts = new Map<string, number>();
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
      const observation: AgentRequestObservation = {
        model: selection?.model ?? `${model.provider}/${model.id}`,
        reasoning: options?.reasoning ?? selection?.reasoning,
        fast_requested: selection?.fastRequested ?? false,
        ...(selection?.serviceTier ? { requested_service_tier: selection.serviceTier } : {}),
        returned_service_tier: "unavailable",
        time_to_first_model_output_ms: "unavailable",
      };
      const request = { observation, startedAt: now() };
      requests.push(observation);
      activeRequest = request;
      try {
        const stream = originalStreamFunction(model, context, options);
        return Promise.resolve(stream).catch((error) => {
          if (activeRequest === request) finishRequest("failed");
          throw error;
        });
      } catch (error) {
        if (activeRequest === request) finishRequest("failed");
        throw error;
      }
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
        toolStarts.set(event.toolCallId, performance.now());
        if (marksSideEffect(event.toolName)) sideEffects = true;
      }
      if (event.type === "tool_execution_end") {
        tools[event.toolName] = (tools[event.toolName] ?? 0) + 1;
        const started = toolStarts.get(event.toolCallId);
        toolStarts.delete(event.toolCallId);
        completeTool(codeIntelligence, event.toolName, denseCallFromExecution(event.toolName, event.result, started, input.signal), navigation);
        navigationWindows.set(session, navigation);
      }
    });
    const handle = resume(session, runtime, selections, now, input);
    const before = usageFrom(session, {});
    if (input.signal.aborted) {
      try {
        await session.abort();
      } finally {
        unsubscribe();
        session.agent.streamFunction = originalStreamFunction;
      }
      return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: attemptUsage(before, session, tools, codeIntelligence), session: handle };
    }
    const stopWatch = watchAbort(input.signal, () => {
      void session.abort();
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      const assistant = lastAssistant(session);
      if (input.signal.aborted) {
        return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: attemptUsage(before, session, tools, codeIntelligence), appliedReasoning: session.thinkingLevel, session: handle };
      }
      if (assistant?.stopReason === "aborted" || assistant?.stopReason === "error") {
        return failedAttempt(assistant.errorMessage ?? assistant.stopReason ?? "provider error", sideEffects, handle, session, attemptUsage(before, session, tools, codeIntelligence), requests);
      }
      return {
        status: "completed",
        result: textOf(assistant),
        sideEffects,
        requests: requests.length ? requests : undefined,
        usage: attemptUsage(before, session, tools, codeIntelligence),
        appliedReasoning: session.thinkingLevel,
        session: handle,
      };
    } catch (error) {
      if (input.signal.aborted) {
        return { status: "cancelled", result: "cancelled", sideEffects, requests: requests.length ? requests : undefined, usage: attemptUsage(before, session, tools, codeIntelligence), session: handle };
      }
      return failedAttempt(messageOf(error), sideEffects, handle, session, attemptUsage(before, session, tools, codeIntelligence), requests);
    } finally {
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
    bindActivityProbe?: Parameters<AttemptExecutor["start"]>[0]["bindActivityProbe"];
  },
): NonNullable<Attempt["session"]> {
  let disposed = false;
  return {
    async continueWith(target, note, signal) {
      return runTarget(runtime, selections, now, target, note, { ...input, signal }, session);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unregisterExecution(session.sessionId);
      await session.dispose();
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

function denseCallFromExecution(name: string, result: any, startedAt: number | undefined, signal: AbortSignal): DenseCallUsage | undefined {
  if (!isDenseToolName(name)) return undefined;
  const details = result?.details ?? result?.result?.details ?? {};
  const measured = details.codeIntelligence;
  if (measured?.tool === name && typeof measured.durationMs === "number" && typeof measured.outputBytes === "number") {
    return measured as DenseCallUsage;
  }
  const text = Array.isArray(result?.content) ? result.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") : "";
  const status = details.status;
  const outcome: ToolOutcome = signal.aborted ? "cancelled" : status === "partial" ? "partial" : status === "unavailable" ? "unavailable" : result?.isError ? "error" : "ok";
  return {
    tool: name,
    durationMs: Math.max(0, Math.round(performance.now() - (startedAt ?? performance.now()))),
    outputBytes: Buffer.byteLength(text),
    truncated: details.truncated === true,
    outcome,
    telemetryAvailable: false,
    sources: {},
  };
}

function attemptUsage(before: AgentUsage, session: AgentSession, tools: Record<string, number>, codeIntelligence: CodeIntelligenceUsage): AgentUsage | undefined {
  const delta = usageDelta(before, usageFrom(session, {}));
  if (!delta) return undefined;
  return { ...delta, tools, contextTokens: usageFrom(session, {}).contextTokens, codeIntelligence: structuredClone(codeIntelligence) };
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

