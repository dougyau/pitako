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
import { childInstructions, skillNamesForRole, type Attempt, type AttemptExecutor } from "./run.ts";
import type { ModelTarget } from "../roles/types.ts";

const SIDE_EFFECT_TOOLS = new Set([
  "edit",
  "write",
  "bash",
  "powershell",
  "board_post",
  "board_topic_create",
  "board_topic_update",
  "lsp_rename",
]);

export function createPiExecutor(): AttemptExecutor {
  return {
    async start(input) {
      const runtime = await ModelRuntime.create({ signal: input.signal, allowModelNetwork: false });
      return runTarget(runtime, input.target, input.task, input, false);
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
  continuing: boolean,
  existing?: AgentSession,
): Promise<Attempt> {
  if (input.signal.aborted) return { status: "cancelled", result: "cancelled", sideEffects: false };
  const model = findModel(runtime, target.model);
  if (!model) {
    return { status: "failed", result: "", error: `model unavailable: ${target.model}`, sideEffects: false };
  }
  const session = existing ?? (await openSession(runtime, model, target, input));
  if (existing) {
    await existing.setModel(model, { persist: false });
    if (target.reasoning) existing.setThinkingLevel(target.reasoning as ThinkingLevel);
  }
  return drive(session, runtime, prompt, input, continuing);
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
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    model,
    thinkingLevel: (target.reasoning ?? "medium") as ThinkingLevel,
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader: loader,
    modelRuntime: runtime,
    excludeTools: ["agent_run"],
  });
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
  continuing: boolean,
): Promise<Attempt> {
  let sideEffects = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && SIDE_EFFECT_TOOLS.has(event.toolName)) sideEffects = true;
  });
  const abort = () => {
    void session.abort();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  const handle = resume(session, runtime, input);
  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
    const assistant = lastAssistant(session);
    if (input.signal.aborted || assistant?.stopReason === "aborted") {
      return { status: "cancelled", result: "cancelled", sideEffects, session: handle };
    }
    if (assistant?.stopReason === "error") {
      return {
        status: "failed",
        result: "",
        error: assistant.errorMessage ?? "provider error",
        sideEffects,
        session: handle,
      };
    }
    const stats = session.getSessionStats();
    return {
      status: "completed",
      result: textOf(assistant),
      sideEffects,
      usage: { input: stats.tokens.input, output: stats.tokens.output, cost: stats.cost },
      session: handle,
    };
  } catch (error) {
    if (input.signal.aborted || isAbort(error)) {
      return { status: "cancelled", result: "cancelled", sideEffects, session: handle };
    }
    return {
      status: "failed",
      result: "",
      error: error instanceof Error ? error.message : String(error),
      sideEffects,
      session: handle,
    };
  } finally {
    input.signal.removeEventListener("abort", abort);
    unsubscribe();
  }
}

function resume(
  session: AgentSession,
  runtime: ModelRuntime,
  input: { instanceId: string; role: Parameters<AttemptExecutor["start"]>[0]["role"]; cwd: string },
): NonNullable<Attempt["session"]> {
  let disposed = false;
  return {
    async continueWith(target, note, signal) {
      return runTarget(runtime, target, note, { ...input, signal }, true, session);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
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

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}
