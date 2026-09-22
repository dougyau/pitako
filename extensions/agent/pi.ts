import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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
import { childActiveTools } from "../profile.ts";
import { marksSideEffect } from "./effects.ts";
import { childInstructions, skillNamesForRole, type AgentUsage, type Attempt, type AttemptExecutor } from "./run.ts";
import type { ModelTarget, ReasoningLevel } from "../roles/types.ts";

/** Omitted reasoning is not forced to medium. Pi keeps its own default. */
export function thinkingLevelFor(reasoning: ReasoningLevel | undefined): ThinkingLevel | undefined {
  return reasoning;
}

export function createPiExecutor(): AttemptExecutor {
  return {
    async start(input) {
      const runtime = await ModelRuntime.create({ signal: input.signal, allowModelNetwork: false });
      return runTarget(runtime, input.target, input.task, input);
    },
  };
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
  },
  existing?: AgentSession,
): Promise<Attempt> {
  if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
  const model = findModel(runtime, target.model);
  if (!model) {
    return { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  let session = existing;
  if (!session) {
    try {
      session = await openSession(runtime, model, target, input);
    } catch (error) {
      return { status: "failed", result: "", error: messageOf(error), sideEffects: false };
    }
  } else {
    const activationError = await activateTarget(session, model, target);
    if (activationError) {
      return { status: "failed", result: "", error: activationError, sideEffects: true, session: resume(session, runtime, input) };
    }
  }
  return drive(session, runtime, prompt, input);
}

export async function activateTarget(
  session: {
    setModel(model: NonNullable<ReturnType<ModelRuntime["getModel"]>>, options?: { persist?: boolean }): Promise<void>;
    setThinkingLevel(level: ThinkingLevel): void;
  },
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  target: ModelTarget,
): Promise<string | undefined> {
  try {
    await session.setModel(model, { persist: false });
    const level = thinkingLevelFor(target.reasoning);
    if (level) session.setThinkingLevel(level);
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}

async function openSession(
  runtime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
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
  const thinkingLevel = thinkingLevelFor(target.reasoning);
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader: loader,
    modelRuntime: runtime,
    excludeTools: ["agent_run"],
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
  },
): Promise<Attempt> {
  let sideEffects = false;
  const tools: Record<string, number> = {};
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && marksSideEffect(event.toolName)) sideEffects = true;
    if (event.type === "tool_execution_end") tools[event.toolName] = (tools[event.toolName] ?? 0) + 1;
  });
  const abort = () => {
    void session.abort();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  const handle = resume(session, runtime, input);
  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
    const assistant = lastAssistant(session);
    if (input.signal.aborted) {
      return { status: "cancelled", result: "cancelled", sideEffects, usage: usageFrom(session, tools), appliedReasoning: session.thinkingLevel, session: handle };
    }
    if (assistant?.stopReason === "aborted" || assistant?.stopReason === "error") {
      return failedAttempt(assistant.errorMessage ?? assistant.stopReason ?? "provider error", sideEffects, handle, session, tools);
    }
    return {
      status: "completed",
      result: textOf(assistant),
      sideEffects,
      usage: usageFrom(session, tools),
      appliedReasoning: session.thinkingLevel,
      session: handle,
    };
  } catch (error) {
    if (input.signal.aborted) {
      return { status: "cancelled", result: "cancelled", sideEffects, usage: usageFrom(session, tools), session: handle };
    }
    return failedAttempt(messageOf(error), sideEffects, handle, session, tools);
  } finally {
    input.signal.removeEventListener("abort", abort);
    unsubscribe();
  }
}

function failedAttempt(
  error: string,
  sideEffects: boolean,
  handle: NonNullable<Attempt["session"]>,
  session: AgentSession,
  tools: Record<string, number>,
): Attempt {
  return {
    status: "failed",
    result: "",
    error,
    sideEffects,
    usage: usageFrom(session, tools),
    appliedReasoning: session.thinkingLevel,
    session: handle,
  };
}

function resume(
  session: AgentSession,
  runtime: ModelRuntime,
  input: { instanceId: string; role: Parameters<AttemptExecutor["start"]>[0]["role"]; cwd: string },
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

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}
