import { randomBytes } from "node:crypto";
import { withBoardAuthor } from "../board/author.ts";
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
  reasoning?: string;
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
  cost?: number;
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
      reasoning: role.modelPolicy.primary.reasoning,
    },
    createdAt: new Date().toISOString(),
  };
  const signal = input.signal ?? new AbortController().signal;
  return agentScope.run({ instanceId: instance.id }, () =>
    withBoardAuthor(instance.id, () => executeTargets(instance, role, task, targets, input.executor, signal)),
  );
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
  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (signal.aborted) return finish(instance, "cancelled", "cancelled", targets[index]);
      const target = targets[index]!;
      instance.model = provenance(instance, target, index);
      let attempt: Attempt;
      if (sideEffects) {
        if (!session) return finish(instance, "failed", "cannot continue after side effects without replaying the task", target, index);
        attempt = await session.continueWith(target, SIDE_EFFECT_NOTE, signal);
      } else {
        await session?.dispose();
        session = undefined;
        attempt = await executor.start({
          instanceId: instance.id,
          role,
          task,
          target,
          cwd: instance.cwd,
          signal,
        });
        session = attempt.session;
      }
      sideEffects = sideEffects || attempt.sideEffects;
      if (attempt.status === "completed") {
        return finish(instance, "completed", attempt.result, target, index, undefined, attempt.usage);
      }
      if (attempt.status === "cancelled" || signal.aborted) {
        return finish(instance, "cancelled", attempt.result || "cancelled", target, index);
      }
      lastError = attempt.error ?? "agent failed";
      const reason = classifyProviderFailure(lastError);
      const more = index + 1 < targets.length;
      if (!reason || !more) {
        return finish(instance, "failed", lastError, target, index, reason);
      }
      instance.model.fallbackReason = reason;
      if (!sideEffects) {
        await session?.dispose();
        session = undefined;
      }
    }
    return finish(instance, "failed", lastError, targets[targets.length - 1]);
  } finally {
    await session?.dispose();
  }
}

function provenance(instance: AgentInstance, target: ModelTarget, index: number): AgentModelProvenance {
  return {
    policyId: instance.model.policyId,
    requestedModel: instance.model.requestedModel,
    selectedModel: target.model,
    reasoning: target.reasoning,
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
    instance.model.reasoning = target.reasoning;
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
  const fallback = result.model.fallbackReason
    ? ` fallback ${result.model.fallbackIndex ?? 0} (${result.model.fallbackReason})`
    : "";
  const usage = result.usage ? `\nusage: in ${result.usage.input} out ${result.usage.output}` : "";
  return `${result.instanceId} ${result.status}\nrole: ${result.role}\nmodel: ${result.model.selectedModel} reasoning ${result.model.reasoning ?? "unset"}${fallback}${usage}\n\n${result.result}`;
}
