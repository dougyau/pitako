import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPitakoConfig } from "../roles/load.ts";
import { executionForSession } from "../execution-identity.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { assertNoCheckpointLease } from "../agent/head/checkpoint-lease.ts";
import { backgroundExecutor, cancelTeamWorker, reserveBackground, type WorkerInterest } from "../agent/background.ts";
import { prepareTeamWatch } from "../agent/index.ts";
import { createTeam, reserveTeamMember, recordTeamAssignment, recordPlanTeamWork, teamEvaluationForSession } from "../team.ts";
import type { HistoryOrigin } from "../agent/history.ts";
import { createTable } from "../table/runtime.ts";
import { captureObject, objectSchema } from "./object.ts";
import { createReviewPolicy } from "./policy.ts";

const rooms = new Map<symbol, Map<string, { instanceId: string; assignmentId: string; runtime?: ReturnType<typeof createTable> }>>();
export function retireReviewRooms(token: symbol) { rooms.delete(token); }
const strict = { additionalProperties: false } as const, text = Type.String({ minLength: 1 });
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

export function registerReview(pi: ExtensionAPI) {
  const evaluationFor = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (currentInstanceId() || executionForSession(id)) throw new Error("review coordinator tools are foreground only");
    const evaluation = teamEvaluationForSession(id, false);
    if (!evaluation) throw new Error("review requires an active foreground Team evaluation");
    assertNoCheckpointLease(ctx.cwd);
    return evaluation;
  };
  const roomFor = (id: string, ctx: ExtensionContext) => {
    const evaluation = evaluationFor(ctx), room = rooms.get(evaluation.token)?.get(id);
    if (!room) throw new Error("unknown or retired review room");
    return { evaluation, room };
  };
  pi.registerTool({ name: "review_start", label: "Start Reviewer table",
    description: "Start an independent, analysis-only Reviewer director and 1–5 Reviewer specialists. Captures the complete selected object and criteria. Returns the real exterior Team handle; only its final report delivers, after all physical closure. Not product acceptance.",
    parameters: Type.Object({ goal: text, object: objectSchema, criteria: Type.Array(text, { minItems: 1 }),
      topic: Type.Optional(text), plan: Type.Optional(text), unit: Type.Optional(text), boardTopicId: Type.Optional(text) }, strict),
    async execute(toolCallId, params, _signal, _update, ctx) {
      try {
        const evaluation = evaluationFor(ctx), config = structuredClone(loadPitakoConfig({ cwd: ctx.cwd }));
        if (!config.review) throw new Error("review is disabled: configuration absent");
        if (!params.goal.trim() || !params.criteria.length || params.criteria.some(item => !item.trim())) throw new Error("review requires goal and nonempty criteria");
        const captured = captureObject(params.object, ctx.cwd);
        const team = createTeam(evaluation), assignmentId = randomUUID();
        const admission = reserveTeamMember(evaluation, "reviewer", assignmentId, team.teamId);
        const origin: HistoryOrigin = { source: "team_assign", entrypoint: "review_start", assignmentId,
          coordinatorSessionId: evaluation.sessionId, coordinatorSessionFile: ctx.sessionManager.getSessionFile(), toolCallId,
          workbrief: params.goal, teamId: team.teamId, memberId: admission.memberId };
        let durableWatch: WorkerInterest | undefined;
        const room: { assignmentId: string; instanceId: string; runtime?: ReturnType<typeof createTable> } = { assignmentId, instanceId: "" };
        try {
          const handle = reserveBackground({ roleId: "reviewer", coordinatorSessionId: evaluation.sessionId, origin, task: params.goal,
            owns: admission.owns,
            teamOwner: { token: admission.token, assignmentId, teamId: team.teamId, memberId: admission.memberId,
              onSettled: admission.settled, noWorkerReleased: admission.noWorkerReleased },
            async cleanup() { if (durableWatch) recordPlanTeamWork(ctx.cwd, durableWatch.planId, durableWatch.unitId, assignmentId, undefined, durableWatch.execution); },
            async prepare(_lifetime, check, reserved) {
              const watched = await prepareTeamWatch(params, ctx, assignmentId, check);
              durableWatch = watched.durableWatch;
              const launchRoot = watched.execution?.executionRoot ?? captured.root;
              if (watched.execution) origin.execution = { executionRoot: launchRoot, executionRef: `${watched.execution.planId}@${watched.execution.revision}:${watched.execution.hash}` };
              const object = launchRoot === captured.root ? captured : captureObject(params.object, launchRoot);
              const review = createReviewPolicy(object, params.goal, [...params.criteria]);
              const runtime = createTable({ team, config, mode: "table", goal: params.goal, topic: params.topic, review,
                root: { assignmentId, memberId: admission.memberId, instanceId: reserved.instanceId }, origin, cwd: launchRoot, owns: reserved.current });
              room.runtime = runtime;
              recordTeamAssignment(evaluation, "reviewer", { id: assignmentId, instanceId: reserved.instanceId, roleId: "reviewer", task: params.goal,
                planId: watched.watch?.planId, unitId: watched.watch?.unitId, boardTopicId: watched.topic, execution: watched.execution, dispatchId: reserved.dispatchId });
              return { roleId: "reviewer", task: params.goal, cwd: launchRoot, historyOrigin: origin, table: runtime.table,
                executor: backgroundExecutor(), maintained: true, driver: runtime.run,
                watch: watched.watch ? { ...watched.watch, execution: watched.execution } : undefined,
                reconcileBookkeeping: durableWatch ? final => recordPlanTeamWork(launchRoot, durableWatch!.planId, durableWatch!.unitId, assignmentId, final.status, watched.execution) : undefined };
            },
          });
          admission.commit(); room.instanceId = handle.instanceId;
          let catalog = rooms.get(evaluation.token);
          if (!catalog) { catalog = new Map(); rooms.set(evaluation.token, catalog); }
          catalog.set(team.teamId, room);
          recordTeamAssignment(evaluation, "reviewer", { id: assignmentId, instanceId: handle.instanceId, roleId: "reviewer", task: params.goal, dispatchId: handle.dispatchId });
          return result({ ...handle, roomId: team.teamId, assignmentId, memberId: admission.memberId });
        } catch (error) { admission.rollback(); throw error; }
      } catch (error) { return { ...result({ error: String(error) }), isError: true }; }
    },
  });
  pi.registerTool({ name: "review_read", label: "Read Reviewer table", description: "Optional bounded diagnostic fragments. Never needed to discover findings in the complete exterior report.",
    parameters: Type.Object({ roomId: text, cursor: Type.Optional(text) }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { room } = roomFor(params.roomId, ctx);
        return result(room.runtime?.read(params.cursor) ?? { roomId: params.roomId, state: "starting", instanceId: room.instanceId, assignmentId: room.assignmentId });
      } catch (error) { return { ...result({ error: String(error) }), isError: true }; }
    },
  });
  pi.registerTool({ name: "review_control", label: "Control Reviewer table", description: "Queue context or priorities without changing object or criteria. Finish drains and synthesizes; stop revokes and joins, never proves closure.",
    parameters: Type.Object({ roomId: text, action: Type.Union([Type.Literal("context"), Type.Literal("priorities"), Type.Literal("finish"), Type.Literal("stop")]), text: Type.Optional(text) }, strict),
    async execute(toolCallId, params, _signal, _update, ctx) {
      try {
        const { evaluation, room } = roomFor(params.roomId, ctx);
        if (room.runtime) return result(room.runtime.control(params.action, params.text, toolCallId));
        if (params.action !== "stop") throw new Error("review preparation pending");
        cancelTeamWorker(evaluation.token, room.instanceId);
        return result({ roomId: params.roomId, state: "stopping" });
      } catch (error) { return { ...result({ error: String(error) }), isError: true }; }
    },
  });
}
