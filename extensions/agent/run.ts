import { randomBytes } from "node:crypto";
import { currentWorkspace } from "../board/workspace.ts";
import { PitakoConfigError } from "../errors.ts";
import { resolveRole, type LoadOptions } from "../roles/load.ts";
import type { FallbackReason, ModelTarget, ResolvedRole } from "../roles/types.ts";
import { classifyProviderFailure } from "./fallback.ts";
import { agentScope } from "./scope.ts";

export type AgentStatus = "created" | "running" | "completed" | "failed" | "cancelled";

export interface AgentModelProvenance {
  policyId?: string;
  requestedModel?: string;
  selectedModel: string;
  requestedReasoning?: string;
  appliedReasoning?: string;
  fallbackIndex?: number;
  fallbackReason?: FallbackReason;
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

export interface AgentRunResult {
  instanceId: string;
  role: string;
  status: Exclude<AgentStatus, "created" | "running">;
  model: AgentModelProvenance;
  result: string;
  usage?: AgentUsage;
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
    "Do not spawn other agents. agent_run is not available.",
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
}): Promise<AgentRunResult> {
  const task = input.task.trim();
  if (task.length === 0) throw new PitakoConfigError("agent_run task must not be empty");
  const role = resolveRole(input.roleId, input.load);
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
  const signal = input.signal ?? new AbortController().signal;
  return agentScope.run({ instanceId: instance.id }, () => executeTargets(instance, role, task, targets, input.executor, signal));
}

async function executeTargets(
  instance: AgentInstance,
  role: ResolvedRole,
  task: string,
  targets: ModelTarget[],
  executor: AttemptExecutor,
  signal: AbortSignal,
): Promise<AgentRunResult> {
  instance.status = "running";
  let session: AttemptSession | undefined;
  let sideEffects = false;
  let lastError = "no model target could be used";
  let usage: AgentUsage | undefined;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (signal.aborted) return finish(instance, "cancelled", "cancelled", undefined, undefined, undefined, usage);
      const target = targets[index]!;
      instance.model = provenance(instance, target, index);
      const attempt = await runAttempt(sideEffects, session, executor, {
        instanceId: instance.id,
        role,
        task,
        target,
        cwd: instance.cwd,
        signal,
      });
      session = attempt.session ?? session;
      sideEffects = sideEffects || attempt.sideEffects;
      usage = mergeUsage(usage, attempt.usage);
      if (attempt.appliedReasoning) instance.model.appliedReasoning = attempt.appliedReasoning;
      if (attempt.status === "completed") {
        return finish(instance, "completed", attempt.result, target, index, undefined, usage);
      }
      lastError = attempt.error ?? "agent failed";
      const reason = classifyProviderFailure(attempt.status === "cancelled" ? undefined : lastError);
      if (reason) instance.model.fallbackReason = reason;
      if (attempt.status === "cancelled" || signal.aborted) {
        return finish(instance, "cancelled", attempt.result || "cancelled", undefined, undefined, instance.model.fallbackReason, usage);
      }
      const more = index + 1 < targets.length;
      if (!reason || !more) {
        return finish(instance, "failed", lastError, target, index, reason, usage);
      }
      instance.model.fallbackReason = reason;
      if (!sideEffects) {
        await session?.dispose();
        session = undefined;
      }
    }
    return finish(instance, "failed", lastError, targets[targets.length - 1], targets.length - 1, undefined, usage);
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
    appliedReasoning: instance.model.appliedReasoning,
    fallbackIndex: index === 0 ? undefined : index - 1,
    fallbackReason: index === 0 ? undefined : instance.model.fallbackReason,
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
): AgentRunResult {
  instance.status = status;
  if (target) {
    instance.model.selectedModel = target.model;
    instance.model.requestedReasoning = target.reasoning;
    instance.model.fallbackIndex = index === 0 ? undefined : index - 1;
    if (reason) instance.model.fallbackReason = reason;
  }
  return {
    instanceId: instance.id,
    role: instance.roleId,
    status,
    model: instance.model,
    result,
    usage,
  };
}

export function formatAgentResult(result: AgentRunResult): string {
  const requested = result.model.requestedModel && result.model.requestedModel !== result.model.selectedModel
    ? `\nrequested: ${result.model.requestedModel}`
    : "";
  const fallback = result.model.fallbackReason ? `\nfallback: ${result.model.fallbackReason} from ${result.model.requestedModel ?? "primary"}` : "";
  const usage = result.usage ? `\n${formatUsage(result.usage)}` : "";
  return [
    `${result.instanceId} ${result.status}`,
    `role: ${result.role}`,
    `model: ${result.model.selectedModel}`,
    requested,
    `reasoning requested: ${result.model.requestedReasoning ?? "default"}`,
    `reasoning applied: ${result.model.appliedReasoning ?? "unknown"}`,
    fallback,
    usage,
    "",
    result.result,
  ].filter((line) => line.length > 0).join("\n");
}

function formatUsage(usage: AgentUsage): string {
  const lines = ["usage:", `  input: ${usage.input}`, `  output: ${usage.output}`];
  if (usage.cacheRead !== undefined) lines.push(`  cached read: ${usage.cacheRead}`);
  if (usage.cacheWrite !== undefined) lines.push(`  cached write: ${usage.cacheWrite}`);
  if (usage.cost !== undefined) lines.push(`  cost: ${usage.cost}`);
  lines.push(`  turns: ${usage.turns ?? "?"}`, `  tools: ${usage.toolCalls ?? "?"}`);
  if (usage.contextTokens !== undefined) lines.push(`  context: ${usage.contextTokens}`);
  return lines.join("\n");
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
