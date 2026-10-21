import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPitakoConfig, resolveRoleFromConfig } from "../roles/load.ts";
import { executionForSession } from "../execution-identity.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { assertNoCheckpointLease } from "../agent/head/checkpoint-lease.ts";
import { backgroundExecutor, cancelTeamWorker, reserveBackground, readTableDiagnostic, type WorkerInterest } from "../agent/background.ts";
import { prepareTeamWatch, captureTeamWatch } from "../agent/index.ts";
import { captureCallContext, checkAuthority, planningSlot, guardToolRegistrations } from "../workflow-engine.ts";
import { createTeam, reserveTeamMember, recordTeamAssignment, recordPlanTeamWork, teamEvaluationForSession } from "../team.ts";
import type { HistoryOrigin } from "../agent/history.ts";
import { createTable } from "../table/runtime.ts";
import { captureObject, captureReviewSource, objectSchema, type CapturedReviewSource, type ObjectSelector } from "./object.ts";
import { createReviewPolicy } from "./policy.ts";
import { tableIncidental as result, tableError, tableReadProperties, type TableRead, type TableRootRegistration } from "../table/results.ts";
import { captureTableArchive } from "../table/archive.ts";

const rooms = new Map<symbol, Map<string, { instanceId: string; assignmentId: string; runtime?: ReturnType<typeof createTable> }>>();
export function retireReviewRooms(token: symbol) { rooms.delete(token); }
const strict = { additionalProperties: false } as const, text = Type.String({ minLength: 1 });
const evaluationFor = (ctx: ExtensionContext) => {
  const id = ctx.sessionManager.getSessionId();
  if (currentInstanceId() || executionForSession(id)) throw new Error("review coordinator tools are foreground only");
  const evaluation = teamEvaluationForSession(id, false);
  if (!evaluation) throw new Error("review requires an active foreground Team evaluation");
  return evaluation;
};

export function registerReview(pi: ExtensionAPI) {
  pi = guardToolRegistrations(pi, "read");
  const roomFor = (id: string, ctx: ExtensionContext) => {
    const evaluation = evaluationFor(ctx), room = rooms.get(evaluation.token)?.get(id);
    if (!room) throw new Error("unknown or retired review room");
    return { evaluation, room };
  };
  pi.registerTool({ name: "review_start", label: "Start Reviewer table",
    description: "Start an independent, analysis-only Reviewer director and zero to five Reviewer specialists. Captures the complete selected object and criteria. Returns the real exterior Team handle; only its final report delivers, after all physical closure. Not product acceptance.",
    parameters: Type.Object({ goal: text, object: objectSchema, criteria: Type.Array(text, { minItems: 1 }),
      topic: Type.Optional(text), plan: Type.Optional(text), unit: Type.Optional(text), boardTopicId: Type.Optional(text) }, strict),
    async execute(toolCallId, params, _signal, _update, ctx) {
      return startReviewTable(toolCallId, params, ctx);
    },
  });
  pi.registerTool({ name: "review_read", label: "Read Reviewer table", description: "Read an immutable diagnostic cut; use roomId from review_start content. Continue with cursor only. Not a final result or acknowledgment.",
    parameters: Type.Object({ roomId: text, ...tableReadProperties }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { evaluation, room } = roomFor(params.roomId, ctx);
        return readTableDiagnostic(evaluation.token, room.instanceId, params as TableRead);
      } catch (error) { return tableError(error); }
    },
  });
  pi.registerTool({ name: "review_control", label: "Control Reviewer table", description: "Queue context or priorities without changing object or criteria. Finish drains and synthesizes; stop revokes and joins, never proves closure.",
    parameters: Type.Object({ roomId: text, action: Type.Union([Type.Literal("context"), Type.Literal("priorities"), Type.Literal("finish"), Type.Literal("stop")]), text: Type.Optional(text) }, strict),
    async execute(toolCallId, params, _signal, _update, ctx) {
      try {
        assertNoCheckpointLease(ctx.cwd);
        const { evaluation, room } = roomFor(params.roomId, ctx);
        if (room.runtime) return result(room.runtime.control(params.action, params.text, toolCallId));
        if (params.action !== "stop") throw new Error("review preparation pending");
        cancelTeamWorker(evaluation.token, room.instanceId);
        return result({ roomId: params.roomId, state: "stopping" });
      } catch (error) { return tableError(error); }
    },
  });
}

/** One host producer, shared by the public definition and the managed planning port. */
export function startReviewTable(toolCallId: string, params: { goal: string; object: ObjectSelector; criteria: string[];
  topic?: string; plan?: string; unit?: string; boardTopicId?: string }, ctx: ExtensionContext, source?: CapturedReviewSource) {
  try {
        assertNoCheckpointLease(ctx.cwd);
        const context = captureCallContext(ctx.cwd, ctx.sessionManager);
        if (context.kind === "managed" && checkAuthority(context.authority).run.phase === "planning" && !source) {
          const slot = planningSlot(context.authority);
          if (params.object.kind !== "plan" || params.object.planId !== slot.id)
            throw new Error("managed review requires the bound FreezeCandidate, not a local selector");
          throw new Error("prepare a FreezeCandidate and use planning review");
        }
        const evaluation = evaluationFor(ctx), config = structuredClone(loadPitakoConfig({ cwd: ctx.cwd }));
        const director = resolveRoleFromConfig(config, "reviewer");
        if (director.modelPolicy.diagnostic) throw new Error(director.modelPolicy.diagnostic);
        if (!params.goal.trim() || !params.criteria.length || params.criteria.some(item => !item.trim())) throw new Error("review requires goal and nonempty criteria");
        const captured = source ? captureReviewSource(source, ctx.cwd) : captureObject(params.object, ctx.cwd);
        const capturedWatch = captureTeamWatch(params, ctx);
        if (capturedWatch.error) throw new Error(capturedWatch.error);
        const team = createTeam(evaluation), assignmentId = randomUUID();
        const admission = reserveTeamMember(evaluation, "reviewer", assignmentId, team.teamId);
        const origin: HistoryOrigin = { source: "team_assign", entrypoint: "review_start", assignmentId,
          coordinatorSessionId: evaluation.sessionId, coordinatorSessionFile: ctx.sessionManager.getSessionFile(), toolCallId,
          workbrief: params.goal, teamId: team.teamId, memberId: admission.memberId };
        let durableWatch: WorkerInterest | undefined;
        const tableRoot: TableRootRegistration = { protocol: "review", archive: captureTableArchive(ctx.cwd, params.plan) };
        const room: { assignmentId: string; instanceId: string; runtime?: ReturnType<typeof createTable> } = { assignmentId, instanceId: "" };
        try {
          const reservationRoot = capturedWatch.execution?.executionRoot ?? ctx.cwd;
          const handle = reserveBackground({ roleId: "reviewer", coordinatorSessionId: evaluation.sessionId, origin, task: params.goal,
            cwd: reservationRoot, context, watch: capturedWatch.watch ? { ...capturedWatch.watch, execution: capturedWatch.execution } : undefined,
            owns: admission.owns, tableRoot,
            teamOwner: { token: admission.token, assignmentId, teamId: team.teamId, memberId: admission.memberId,
              onSettled: admission.settled, noWorkerReleased: admission.noWorkerReleased },
            async cleanup() { if (durableWatch) recordPlanTeamWork(ctx.cwd, durableWatch.planId, durableWatch.unitId, assignmentId, undefined, durableWatch.execution); },
            async prepare(_lifetime, check, reserved) {
              const watched = await prepareTeamWatch(params, ctx, assignmentId, check, undefined, capturedWatch);
              durableWatch = watched.durableWatch;
              const launchRoot = watched.execution?.executionRoot ?? (tableRoot.archive && "root" in tableRoot.archive ? tableRoot.archive.root : captured.root);
              if (watched.execution) origin.execution = { executionRoot: launchRoot, executionRef: `${watched.execution.planId}@${watched.execution.revision}:${watched.execution.hash}` };
              const object = source && source.kind !== "local-selector" || launchRoot === captured.root ? captured : captureObject(params.object, launchRoot);
              const review = createReviewPolicy(object, params.goal, [...params.criteria]);
              const runtime = createTable({ team, config, goal: params.goal, topic: params.topic, review,
                root: { assignmentId, memberId: admission.memberId, instanceId: reserved.instanceId }, origin, cwd: launchRoot, owns: reserved.current });
              tableRoot.semantic = runtime.semantic;
              tableRoot.diagnostic = runtime.diagnostic;
              room.runtime = runtime;
              recordTeamAssignment(evaluation, "reviewer", { id: assignmentId, instanceId: reserved.instanceId, roleId: "reviewer", task: params.goal,
                planId: watched.watch?.planId, unitId: watched.watch?.unitId, boardTopicId: watched.topic, execution: watched.execution, dispatchId: reserved.dispatchId });
              return { roleId: "reviewer", task: params.goal, cwd: launchRoot, historyOrigin: origin, table: runtime.table,
                executor: backgroundExecutor(), maintained: true, driver: runtime.run,
                watch: watched.watch ? { ...watched.watch, execution: watched.execution } : undefined,
                reconcileBookkeeping: durableWatch ? (final, receipt) => recordPlanTeamWork(launchRoot, durableWatch!.planId, durableWatch!.unitId, assignmentId, final.status, watched.execution, receipt) : undefined };
            },
          });
          admission.commit(); room.instanceId = handle.instanceId;
          let catalog = rooms.get(evaluation.token);
          if (!catalog) { catalog = new Map(); rooms.set(evaluation.token, catalog); }
          catalog.set(team.teamId, room);
          recordTeamAssignment(evaluation, "reviewer", { id: assignmentId, instanceId: handle.instanceId, roleId: "reviewer", task: params.goal, dispatchId: handle.dispatchId });
          return result({ ...handle, roomId: team.teamId, assignmentId, memberId: admission.memberId });
        } catch (error) { admission.rollback(); throw error; }
      } catch (error) { return tableError(error); }
}
