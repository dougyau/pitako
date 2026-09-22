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
} from "@earendil-works/pi-coding-agent";
import { registerExecution, unregisterExecution } from "../execution-identity.ts";
import { childActiveTools, ORCHESTRATION_TOOLS } from "../profile.ts";
import { marksSideEffect } from "./effects.ts";
import { childInstructions, skillNamesForRole, usageDelta, type AgentUsage, type Attempt, type AttemptExecutor } from "./run.ts";
import type { ModelTarget, ReasoningLevel } from "../roles/types.ts";

// Package entry does not re-export this. Import the file next to the resolved entry.
export const { DEFAULT_THINKING_LEVEL } = await import(
  new URL("./core/defaults.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
) as { DEFAULT_THINKING_LEVEL: ThinkingLevel };

/** Omitted reasoning is not forced to medium. Pi keeps its own default. */
export function thinkingLevelFor(reasoning: ReasoningLevel | undefined): ThinkingLevel | undefined {
  return reasoning;
}

export function createPiExecutor(): AttemptExecutor {
  return {
    async start(input) {
      // Do not bind the worker abort signal here. The session abort owns cancellation.
      // A signal on runtime create aborts Cursor auth before the child prompt starts.
      const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
      keepCursorTools(runtime);
      return runTarget(runtime, input.target, input.task, input);
    },
  };
}

/** ModelRuntime.streamSimple drops context.tools. Cursor then runs its own shell and that stream does not finish. */
export function cursorProviderContext(model: { provider?: string; api?: string }, context: Context): Context {
  if (model.provider !== "cursor" && model.api !== "cursor-native") return context;
  return { ...normalizeContext(context), tools: context.tools ?? [] };
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
  let model = findModel(runtime, target.model);
  // Extension providers register during AgentSession bind, not on a fresh runtime.
  if (!model && !existing) {
    return bindThenRun(runtime, target, prompt, input);
  }
  if (!model) {
    return { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  let session = existing;
  if (!session) {
    try {
      session = await openSession(runtime, model, target, input);
      if (session.thinkingLevel) input.onActivated?.(session.thinkingLevel);
      if (input.signal.aborted) {
        await resume(session, runtime, input).dispose();
        return { status: "cancelled", result: "cancelled", sideEffects: false };
      }
    } catch (error) {
      if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
      return { status: "failed", result: "", error: messageOf(error), sideEffects: false };
    }
  } else {
    const activationError = await activateTarget(session, model, target);
    if (activationError) {
      return { status: "failed", result: "", error: activationError, sideEffects: true, session: resume(session, runtime, input) };
    }
    if (session.thinkingLevel) input.onActivated?.(session.thinkingLevel);
  }
  return drive(session, runtime, prompt, input);
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
  if (input.signal.aborted) {
    await resume(session, runtime, input).dispose();
    return { status: "cancelled", result: "cancelled", sideEffects: false };
  }
  const model = findModel(runtime, target.model);
  if (!model) {
    await resume(session, runtime, input).dispose();
    return { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  const activationError = await activateTarget(session, model, target);
  if (activationError) {
    await resume(session, runtime, input).dispose();
    return { status: "failed", result: "", error: activationError, sideEffects: false };
  }
  if (session.thinkingLevel) input.onActivated?.(session.thinkingLevel);
  return drive(session, runtime, prompt, input);
}

async function openSession(
  runtime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>> | undefined,
  target: ModelTarget,
  input: { instanceId: string; role: Parameters<AttemptExecutor["start"]>[0]["role"]; cwd: string },
): Promise<AgentSession> {
  const agentDir = getAgentDir();
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
  const thinkingLevel = model ? thinkingLevelFor(target.reasoning) : undefined;
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader: loader,
    modelRuntime: runtime,
    excludeTools: [...ORCHESTRATION_TOOLS],
  });
  session.setActiveToolsByName(childActiveTools(session.getAllTools().map((tool) => tool.name)));
  registerExecution({ instanceId: input.instanceId, roleId: input.role.id, sessionId: session.sessionId });
  return session;
}

async function drive(
  session: AgentSession,
  runtime: ModelRuntime,
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
    const unsubscribe = session.subscribe((event) => {
      input.onActivity?.(event);
      if (event.type === "tool_execution_start" && marksSideEffect(event.toolName)) sideEffects = true;
      if (event.type === "tool_execution_end") tools[event.toolName] = (tools[event.toolName] ?? 0) + 1;
    });
    const handle = resume(session, runtime, input);
    const before = usageFrom(session, {});
    if (input.signal.aborted) {
      await session.abort();
      return { status: "cancelled", result: "cancelled", sideEffects, usage: attemptUsage(before, session, tools), session: handle };
    }
    const stopWatch = watchAbort(input.signal, () => {
      void session.abort();
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      const assistant = lastAssistant(session);
      if (input.signal.aborted) {
        return { status: "cancelled", result: "cancelled", sideEffects, usage: attemptUsage(before, session, tools), appliedReasoning: session.thinkingLevel, session: handle };
      }
      if (assistant?.stopReason === "aborted" || assistant?.stopReason === "error") {
        return failedAttempt(assistant.errorMessage ?? assistant.stopReason ?? "provider error", sideEffects, handle, session, attemptUsage(before, session, tools));
      }
      return {
        status: "completed",
        result: textOf(assistant),
        sideEffects,
        usage: attemptUsage(before, session, tools),
        appliedReasoning: session.thinkingLevel,
        session: handle,
      };
    } catch (error) {
      if (input.signal.aborted) {
        return { status: "cancelled", result: "cancelled", sideEffects, usage: attemptUsage(before, session, tools), session: handle };
      }
      return failedAttempt(messageOf(error), sideEffects, handle, session, attemptUsage(before, session, tools));
    } finally {
      stopWatch();
      unsubscribe();
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
): Attempt {
  return {
    status: "failed",
    result: "",
    error,
    sideEffects,
    usage,
    appliedReasoning: session.thinkingLevel,
    session: handle,
  };
}

function resume(
  session: AgentSession,
  runtime: ModelRuntime,
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
      return runTarget(runtime, target, note, { ...input, signal }, session);
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

function attemptUsage(before: AgentUsage, session: AgentSession, tools: Record<string, number>): AgentUsage | undefined {
  const delta = usageDelta(before, usageFrom(session, {}));
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

