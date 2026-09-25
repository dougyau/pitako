import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PitakoConfigError } from "../errors.ts";
import {
  backgroundExecutor,
  cancelWorker,
  formatWorkerHandle,
  formatWorkerViews,
  interestFrom,
  spawnBackground,
  workerResult,
  workerStatus,
  teamWorkerStatus,
  teamWorkerResult,
  teamWorkerHasOutcome,
  cancelTeamWorker,
} from "./background.ts";
import { listObservations, noteResultTaken, observationEpoch, publishObservation } from "./observe.ts";
import { currentInstanceId } from "./scope.ts";
import { createPiExecutor } from "./pi.ts";
import { formatAgentResult, formatTeamExecutionSummary, runAgentInstance, teamExecutionSummary } from "./run.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openBoard } from "../board/store.ts";
import { boardWorkspace, currentWorkspace } from "../board/workspace.ts";
import { ledgerFile, openExecutionPlan, planFile, readFrozenPlan, readPlan, type ExecutionBinding, type PlanMeta } from "../workflow.ts";
import { teamEvaluationForSession, reserveTeamRole, recordTeamAssignment, recordPlanTeamWork, teamAssignments, type TeamAssignment } from "../team.ts";

const noExtra = { additionalProperties: false } as const;

export default function agentInstance(pi: ExtensionAPI): void {
  registerBackgroundTools(pi);
  registerTeamTools(pi);
  pi.registerTool({
    name: "agent_run",
    label: "Run agent",
    description:
      "Run one Pitako role in an isolated context. Returns the final result and model provenance, not the child transcript. If this fails, report the failure. Do not perform that role yourself.",
    promptSnippet: "Run an isolated Pitako role and return its final result",
    promptGuidelines: [
      "Use agent_run for a role such as architect or researcher. If agent_run fails, report the error. Do not do that role's work in the parent session.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ description: "Role id, for example architect" }),
        task: Type.String({ description: "Explicit task for the isolated agent" }),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (currentInstanceId()) {
        return errorResult("agent_run cannot be called from an AgentInstance");
      }
      try {
        let live = "";
        const epoch = observationEpoch();
        const result = await runAgentInstance({
          roleId: params.role,
          task: params.task,
          cwd: ctx.cwd,
          signal,
          executor: createPiExecutor(),
          onPresent(text) {
            live = text;
            onUpdate?.({
              content: [{ type: "text", text }],
              details: { live: text },
            });
          },
          onObserve(snapshot) {
            publishObservation(snapshot, epoch);
          },
        });
        noteResultTaken(result.instanceId);
        return {
          content: [{ type: "text", text: formatAgentResult(result) }],
          details: { ...result, live },
          isError: result.status !== "completed",
        };
      } catch (error) {
        const message = error instanceof PitakoConfigError || error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("agent_run")) + theme.fg("accent", ` ${args.role}`), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as { live?: string } | undefined;
      const full = result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
      const text = options.expanded ? full : details?.live || full;
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}

function registerTeamTools(pi: ExtensionAPI): void {
  const roles = ["architect", "developer", "reviewer", "researcher"] as const;
  const evaluationFor = (ctx: { sessionManager?: { getSessionId?: () => string | undefined } }) =>
    teamEvaluationForSession(
      typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
      Boolean(currentInstanceId() || process.env.PITAKO_INSTANCE_ID),
    );
  const assignmentsFor = (evaluation: NonNullable<ReturnType<typeof teamEvaluationForSession>>) =>
    teamAssignments(evaluation).flatMap((slot) => [slot.current, slot.last].filter((item): item is TeamAssignment => Boolean(item)));
  const findAssignment = (evaluation: NonNullable<ReturnType<typeof teamEvaluationForSession>>, id: string) => {
    const assignment = assignmentsFor(evaluation).find((item) => item.id === id);
    if (!assignment) throw new Error(`unknown Team assignment ${id}`);
    return assignment;
  };

  pi.registerTool({
    name: "team_assign",
    label: "Assign Team role",
    description: "Start one isolated Team role. Returns immediately. One assignment per role may run at a time.",
    promptSnippet: "Assign independent work to a Team role",
    promptGuidelines: ["Use team_assign for independent long work. Keep task scoped. Do not wait or poll; on a watched plan/unit completion wake, resume and fetch it with team_result using the assignment ID."],
    parameters: Type.Object({
      role: Type.String({ enum: [...roles] }),
      task: Type.String({ minLength: 1, description: "Scoped WorkBrief for this role" }),
      plan: Type.Optional(Type.String()),
      unit: Type.Optional(Type.String()),
      boardTopicId: Type.Optional(Type.String({ description: "Existing Board topic ID; no topic is created" })),
    }, noExtra),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const evaluation = evaluationFor(ctx);
        const id = randomUUID();
        const admission = reserveTeamRole(evaluation, params.role, id);
        let accepted = false;
        let durableWatch: { planId: string; unitId: string; execution?: ExecutionBinding } | undefined;
        try {
          const watch = interestFrom(params.plan, params.unit);
          let plan: { file: string; text: string; meta: PlanMeta } | undefined;
          let execution: ExecutionBinding | undefined;
          if (watch) {
            plan = existsSync(ledgerFile(watch.planId, ctx.cwd))
              ? openExecutionPlan(watch.planId, ctx.cwd, { createLedger: false })
              : assignmentPlan(watch.planId, ctx.cwd);
          }
          const topic = await teamBoardTopic(params.boardTopicId, watch?.planId, ctx.cwd, plan?.meta);
          if (watch && plan?.meta.status === "frozen") {
            const opened = openExecutionPlan(watch.planId, ctx.cwd, { createLedger: true, source: plan });
            plan = opened;
            execution = opened.binding;
            if (topic !== undefined) await claimTeamBoardTopicExecution(topic, opened.meta, ctx.cwd, opened.binding.executionRoot);
          }
          if (watch && topic !== undefined && plan) {
            durableWatch = { ...watch, execution };
            recordPlanTeamWork(ctx.cwd, watch.planId, watch.unitId, id, "pending", execution);
          }
          const task = [
            `Team assignment header: Team ${evaluation!.sessionId}; role ${params.role}; assignment ${id}${topic !== undefined ? `; Board topic ${topic}` : ""}.`,
            "WorkBrief:",
            params.task.trim(),
          ].join("\n");
          const handle = await spawnBackground({
            roleId: params.role,
            task,
            cwd: execution?.executionRoot ?? ctx.cwd,
            foreground: signal,
            watch: watch ? { ...watch, execution } : undefined,
            executor: backgroundExecutor(),
            teamOwner: {
              token: admission.token,
              assignmentId: id,
              onSettled() { admission.settled(); },
            },
          });
          accepted = true;
          admission.commit();
          const assignment: TeamAssignment = {
            id, instanceId: handle.instanceId, roleId: params.role, task: params.task.trim(),
            planId: watch?.planId, unitId: watch?.unitId, boardTopicId: topic, execution,
          };
          recordTeamAssignment(evaluation!, params.role, assignment);
          return textResult(`assignment_id: ${id}\nrole: ${params.role}\ninstance_id: ${handle.instanceId}\nstatus: running`, assignment);
        } catch (error) {
          if (!accepted) {
            if (durableWatch) {
              try { recordPlanTeamWork(ctx.cwd, durableWatch.planId, durableWatch.unitId, id, undefined, durableWatch.execution); } catch { /* original assignment failure takes precedence */ }
            }
            admission.rollback();
          }
          throw error;
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "team_status",
    label: "Team status",
    description: "Show stable ordered Team role status. Does not wait or include task text or transcripts.",
    promptSnippet: "Inspect Team assignments without waiting",
    parameters: Type.Object({ assignmentId: Type.Optional(Type.String()) }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const evaluation = evaluationFor(ctx);
        if (!evaluation) throw new Error("Team requires a foreground session identity");
        const slots = teamAssignments(evaluation);
        const rows = roles.map((role, index) => {
          const assignment = slots[index]?.current;
          const last = slots[index]?.last;
          const selected = params.assignmentId ? [assignment, last].find((item) => item?.id === params.assignmentId) : assignment;
          if (params.assignmentId && !selected) return undefined;
          const row = selected ?? assignment ?? last;
          if (!row) return { role, status: "idle" };
          const view = teamWorkerStatus(evaluation.token, row.instanceId)[0];
          const observation = listObservations(evaluation.token).find((item) => item.id === row.instanceId);
          return {
            role,
            assignmentId: row.id,
            instanceId: row.instanceId,
            task: row.task.split("\n").find((line) => line.trim())?.trim().slice(0, 100) ?? "",
            status: view?.status ?? "settled",
            model: observation?.modelLabel ?? observation?.selectedModel,
            reasoning: observation?.appliedReasoning ?? observation?.requestedReasoning,
            activity: observation?.activeTool,
            elapsedMs: view?.elapsedMs,
            resultAvailable: teamWorkerHasOutcome(evaluation.token, row.instanceId),
          };
        }).filter((row) => row !== undefined);
        if (params.assignmentId && rows.length === 0) throw new Error(`unknown Team assignment ${params.assignmentId}`);
        return textResult(JSON.stringify(rows), { roles: rows });
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  });

  pi.registerTool({
    name: "team_result",
    label: "Team result",
    description: "Return one settled Team result, capped at 8000 characters. Does not wait.",
    promptSnippet: "Fetch a finished Team assignment result",
    parameters: Type.Object({ assignmentId: Type.String() }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const evaluation = evaluationFor(ctx);
        if (!evaluation) throw new Error("Team requires a foreground session identity");
        const assignment = findAssignment(evaluation, params.assignmentId);
        const result = teamWorkerResult(evaluation.token, assignment.instanceId);
        if (assignment.planId && assignment.unitId && assignment.boardTopicId !== undefined) {
          recordPlanTeamWork(ctx.cwd, assignment.planId, assignment.unitId, assignment.id, result.status, assignment.execution);
        }
        const summary = teamExecutionSummary(assignment.id, result);
        const prefix = `${formatTeamExecutionSummary(summary)}\n\n`;
        const limit = 8000;
        const truncationNote = "\n[truncated; use a narrower assignment]";
        const available = Math.max(0, limit - prefix.length);
        const truncated = result.result.length > available;
        const resultLimit = truncated ? Math.max(0, available - truncationNote.length) : available;
        return textResult(`${prefix}${result.result.slice(0, resultLimit)}${truncated ? truncationNote : ""}`, {
          assignmentId: assignment.id, instanceId: result.instanceId, role: result.role,
          status: result.status, model: result.model, usage: result.usage, summary, truncated, resultLength: result.result.length,
        }, result.status !== "completed");
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  });

  pi.registerTool({
    name: "team_cancel",
    label: "Cancel Team assignment",
    description: "Cancel one Team assignment. Its role stays occupied until worker settles.",
    promptSnippet: "Cancel one Team assignment without waiting",
    parameters: Type.Object({ assignmentId: Type.String() }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const evaluation = evaluationFor(ctx);
        if (!evaluation) throw new Error("Team requires a foreground session identity");
        const assignment = findAssignment(evaluation, params.assignmentId);
        const view = cancelTeamWorker(evaluation.token, assignment.instanceId);
        return textResult(JSON.stringify({ assignmentId: assignment.id, ...view }), { assignmentId: assignment.id, ...view });
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  });
}

function watchedExecutionBinding(planId: string, cwd: string): ExecutionBinding | undefined {
  if (existsSync(ledgerFile(planId, cwd))) return openExecutionPlan(planId, cwd, { createLedger: true }).binding;
  const plan = assignmentPlan(planId, cwd);
  if (!plan || plan.meta.status !== "frozen") return undefined;
  return openExecutionPlan(planId, cwd, { createLedger: true, source: plan }).binding;
}

function assignmentPlan(planId: string, cwd: string): { file: string; text: string; meta: PlanMeta } | undefined {
  const local = planFile(planId, cwd);
  if (existsSync(local)) return readPlan(planId, cwd);
  try { return readFrozenPlan(planId, cwd); }
  catch (error) {
    if (error instanceof Error && error.message.includes("PLAN_NOT_FOUND")) return undefined;
    throw error;
  }
}

async function teamBoardTopic(
  explicit: string | undefined,
  planId: string | undefined,
  cwd: string,
  plan?: PlanMeta,
): Promise<number | undefined> {
  let explicitId: number | undefined;
  if (explicit !== undefined) {
    const value = explicit.trim();
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error("Board topic ID must be a positive safe integer");
    }
    explicitId = Number(value);
  }
  if (explicitId !== undefined && (!planId || (plan && plan.boardTopicId === undefined))) {
    throw new Error("explicit Board topics require a bound watched plan; only planning assignments with a missing plan artifact may pass an explicit topic");
  }
  if (planId && !plan && explicitId === undefined) return undefined;
  const topicId = plan?.boardTopicId ?? (planId && !plan ? explicitId : undefined);
  if (plan?.boardTopicId !== undefined && explicitId !== undefined && plan.boardTopicId !== explicitId) {
    throw new Error("explicit Board topic ID conflicts with the watched plan binding");
  }
  if (topicId === undefined) return undefined;

  const board = await openBoard();
  try {
    const location = boardWorkspace(cwd);
    board.migrateLegacyWorkspaces(location.identity, location.legacyRoots);
    const topic = board.readTopic(location.identity, topicId).topic;
    if (plan?.boardTopicId !== undefined && topic.ownerPlanId !== plan.id) {
      throw new Error(`Board topic ${topicId} is not owned by watched plan ${plan.id}`);
    }
    if (!plan && topic.ownerPlanId !== null) {
      throw new Error(`Board topic ${topicId} is not unowned for planning assignment`);
    }
    if (topic.ownerPlanId !== null && (plan?.boardTopicId === undefined || topic.ownerPlanId !== plan.id)) {
      throw new Error(`Board topic ${topicId} is not bound to the watched plan`);
    }
    if (plan?.status === "frozen" && (topic.planRevision !== null || topic.planHash !== null || topic.executionRoot !== null)) {
      if (topic.planRevision === null || topic.planHash === null || topic.executionRoot === null) {
        throw new Error(`Board topic ${topicId} has an incomplete frozen execution claim`);
      }
      if (topic.executionRoot !== currentWorkspace(cwd)) {
        throw new Error(`Board topic ${topicId} is pinned to execution worktree ${topic.executionRoot}`);
      }
      if (topic.planRevision !== plan.revision || topic.planHash !== plan.hash) {
        throw new Error(`Board topic ${topicId} frozen plan identity does not match revision ${plan.revision} and hash ${plan.hash}`);
      }
    }
    return topicId;
  } finally {
    board.close();
  }
}

async function claimTeamBoardTopicExecution(
  topicId: number,
  plan: PlanMeta,
  cwd: string,
  executionRoot: string,
): Promise<void> {
  const board = await openBoard();
  try {
    const location = boardWorkspace(cwd);
    board.migrateLegacyWorkspaces(location.identity, location.legacyRoots);
    board.claimTopicExecution(location.identity, topicId, plan.id, {
      revision: plan.revision,
      hash: plan.hash,
      executionRoot,
    });
  } finally {
    board.close();
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
    isError: true,
  };
}

function childBlocked(tool: string) {
  if (currentInstanceId() || process.env.PITAKO_INSTANCE_ID) {
    return errorResult(`${tool} cannot be called from an AgentInstance`);
  }
  return undefined;
}

function textResult(text: string, details: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

function registerBackgroundTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_spawn",
    label: "Spawn agent",
    description:
      "Start one Pitako role in the background and return its instance id while it is still running. Does not wait for the result. A failure is not permission to do that role in the parent.",
    promptSnippet: "Start a background Pitako role and return before it finishes",
    promptGuidelines: [
      "Use agent_spawn for long specialist work that can continue while you stay available. Do not call agent_result in the same turn. If it fails, report the error. Do not do that role yourself.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ description: "Role id, for example developer" }),
        task: Type.String({ description: "Explicit task for the isolated agent" }),
        plan: Type.Optional(Type.String({ description: "Plan id when an execution workflow should wake on completion" })),
        unit: Type.Optional(Type.String({ description: "Unit id paired with plan" })),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const blocked = childBlocked("agent_spawn");
      if (blocked) return blocked;
      try {
        const watch = interestFrom(params.plan, params.unit);
        const execution = watch ? watchedExecutionBinding(watch.planId, ctx.cwd) : undefined;
        const handle = await spawnBackground({
          roleId: params.role,
          task: params.task,
          cwd: execution?.executionRoot ?? ctx.cwd,
          foreground: signal,
          watch: watch ? { ...watch, execution } : undefined,
          executor: backgroundExecutor(),
        });
        return textResult(formatWorkerHandle(handle), handle);
      } catch (error) {
        const message = error instanceof PitakoConfigError || error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  });

  pi.registerTool({
    name: "agent_status",
    label: "Agent status",
    description: "Return compact background worker status. Does not wait for completion and does not include the result.",
    promptSnippet: "Inspect background workers without waiting",
    promptGuidelines: ["Use agent_status to see who is running. Do not poll it in a loop."],
    parameters: Type.Object(
      { id: Type.Optional(Type.String({ description: "Instance id. Omit to list every worker." })) },
      noExtra,
    ),
    async execute(_toolCallId, params) {
      const blocked = childBlocked("agent_status");
      if (blocked) return blocked;
      try {
        const views = workerStatus(params.id);
        return textResult(formatWorkerViews(views), { workers: views });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "agent_result",
    label: "Agent result",
    description:
      "Return one finished background worker result. Errors if it is still running. Does not wait. A failure is not permission to do that role in the parent.",
    promptSnippet: "Fetch a finished background worker result",
    promptGuidelines: ["Call agent_result only after a completion signal or a terminal agent_status. Do not poll."],
    parameters: Type.Object({ id: Type.String({ description: "Instance id" }) }, noExtra),
    async execute(_toolCallId, params) {
      const blocked = childBlocked("agent_result");
      if (blocked) return blocked;
      try {
        const result = workerResult(params.id);
        return textResult(formatAgentResult(result), result, result.status !== "completed");
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel agent",
    description: "Cancel one background worker. Does not wait for the run to finish. Does not cancel other workers.",
    promptSnippet: "Cancel one background worker",
    promptGuidelines: ["Use agent_cancel only for the worker you intend to stop."],
    parameters: Type.Object({ id: Type.String({ description: "Instance id" }) }, noExtra),
    async execute(_toolCallId, params) {
      const blocked = childBlocked("agent_cancel");
      if (blocked) return blocked;
      try {
        const view = cancelWorker(params.id);
        return textResult(formatWorkerViews([view]), view);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
