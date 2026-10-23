import { architectureRoom, registerArchitectureRoom, captureArchitecture, architectureControl, architectureControlApplied } from "./rooms.ts";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPitakoConfig, resolveRoleFromConfig } from "../roles/load.ts";
import { executionForSession } from "../execution-identity.ts";
import { currentInstanceId } from "../agent/scope.ts";
import { assertNoCheckpointLease } from "../agent/head/checkpoint-lease.ts";
import { backgroundExecutor, cancelTeamWorker, reserveBackground, readTableDiagnostic, type WorkerInterest } from "../agent/background.ts";
import { prepareTeamWatch, captureTeamWatch } from "../agent/index.ts";
import { captureCallContext, guardToolRegistrations } from "../workflow-engine.ts";
import { createTeam, reserveTeamMember, recordTeamAssignment, recordPlanTeamWork, teamEvaluationForSession } from "../team.ts";
import type { HistoryOrigin } from "../agent/history.ts";
import { createConsultation } from "./runtime.ts";
import { tableIncidental as result, tableError, tableReadProperties, type TableRead, type TableRootRegistration } from "../table/results.ts";
import { captureTableArchive } from "../table/archive.ts";
const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const briefGuidance = "Write goal as a self-contained Markdown work brief in its original language: short title, objective and expected result. Add context, questions, restrictions and references when useful. Use short paragraphs and lists; no required HTML, wide tables, frontmatter or empty sections. This is authorship guidance, not validation: plain text remains valid and submitted text is preserved without conversion or normalization.";

export function registerArchitecture(pi: ExtensionAPI) {
  pi = guardToolRegistrations(pi, "read");
  const evaluationFor = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (currentInstanceId() || executionForSession(id)) throw new Error("architecture coordinator tools are foreground only");
    const evaluation = teamEvaluationForSession(id, false);
    if (!evaluation) throw new Error("architecture requires an active foreground Team evaluation");
    return evaluation;
  };
  const roomFor = (id: string, ctx: ExtensionContext) => {
    const evaluation = evaluationFor(ctx), room = architectureRoom(evaluation, id);
    if (!room || room.evaluation.token !== evaluation.token) throw new Error("unknown or retired architecture room");
    return room;
  };
  const protect = (execute: (...args: any[]) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>) => async (...args: any[]) => {
    try { return await execute(...args); }
    catch (error) { return tableError(error); }
  };
  pi.registerTool({ name: "architecture_start", label: "Start Architect table",
    description: `Start an analysis-only Architect-directed table with zero to five specialists, two supports and five rounds. Returns the real Architect Team result/cancel handle. Only the root delivers synthesis, after disband. ${briefGuidance}`,
    parameters: Type.Object({ goal: Type.String({ minLength: 1, description: briefGuidance }), topic: Type.Optional(text), plan: Type.Optional(text), unit: Type.Optional(text), boardTopicId: Type.Optional(text) }, strict),
    async execute(toolCallId, params, _signal, _update, ctx) {
      try {
        assertNoCheckpointLease(ctx.cwd, true);
        const context = captureCallContext(ctx.cwd, ctx.sessionManager);
        const captured = captureTeamWatch(params, ctx);
        if (captured.error) throw new Error(captured.error);
        const consultedSource = "planning" in captured && captured.planning ?
          { identity: captured.planning.snapshot.objectHash!, text: captured.planning.snapshot.text! } : undefined;
        const evaluation = evaluationFor(ctx), config = structuredClone(loadPitakoConfig({ cwd: ctx.cwd }));
        const director = resolveRoleFromConfig(config, "architect");
        if (director.modelPolicy.diagnostic) throw new Error(director.modelPolicy.diagnostic);
        const team = createTeam(evaluation), assignmentId = randomUUID();
        const admission = reserveTeamMember(evaluation, "architect", assignmentId, team.teamId);
        const origin: HistoryOrigin = { source: "team_assign", entrypoint: "architecture_start", assignmentId,
          coordinatorSessionId: evaluation.sessionId, coordinatorSessionFile: ctx.sessionManager.getSessionFile(), toolCallId,
          workbrief: params.goal, teamId: team.teamId, memberId: admission.memberId };
        let durableWatch: WorkerInterest | undefined;
        const tableRoot: TableRootRegistration = { protocol: "architecture", archive: captureTableArchive(ctx.cwd, params.plan) };
        try {
          const reservationRoot = captured.execution?.executionRoot ?? ctx.cwd;
          const handle = reserveBackground({ roleId: "architect", coordinatorSessionId: evaluation.sessionId, origin, task: params.goal,
            cwd: reservationRoot, context, watch: captured.watch ? { ...captured.watch, execution: captured.execution } : undefined,
            owns: admission.owns, tableRoot,
            teamOwner: { token: admission.token, assignmentId, teamId: team.teamId, memberId: admission.memberId,
              onSettled: admission.settled, noWorkerReleased: admission.noWorkerReleased },
            async cleanup() { if (durableWatch) recordPlanTeamWork(ctx.cwd, durableWatch.planId, durableWatch.unitId, assignmentId, undefined, durableWatch.execution); },
            async prepare(_lifetime, check, reserved) {
              const watched = await prepareTeamWatch(params, ctx, assignmentId, check, undefined, captured);
              durableWatch = watched.durableWatch;
              const launchRoot = watched.execution?.executionRoot ?? (tableRoot.archive && "root" in tableRoot.archive ? tableRoot.archive.root : ctx.cwd);
              if (watched.execution) origin.execution = { executionRoot: launchRoot, executionRef: `${watched.execution.planId}@${watched.execution.revision}:${watched.execution.hash}` };
              const runtime = createConsultation({ team, config, goal: params.goal, topic: params.topic, consultedSource, root: { assignmentId, memberId: admission.memberId, instanceId: reserved.instanceId },
                origin, cwd: launchRoot, owns: reserved.current, observation: architectureRoom(evaluation, team.teamId) });
              tableRoot.semantic = runtime.semantic;
              tableRoot.diagnostic = runtime.diagnostic;
              captureArchitecture(architectureRoom(evaluation, team.teamId), room => { room.runtime = runtime; room.runtimeCreated = true; });
              recordTeamAssignment(evaluation, "architect", { id: assignmentId, instanceId: reserved.instanceId, roleId: "architect", task: params.goal,
                planId: watched.watch?.planId, unitId: watched.watch?.unitId, boardTopicId: watched.topic, execution: watched.execution, dispatchId: reserved.dispatchId });
              return { roleId: "architect", task: params.goal, cwd: launchRoot, historyOrigin: origin, architecture: runtime.architecture,
                executor: backgroundExecutor(), maintained: true, driver: runtime.run, watch: watched.watch ? { ...watched.watch, execution: watched.execution } : undefined,
                reconcileBookkeeping: durableWatch ? (final, receipt) => recordPlanTeamWork(launchRoot, durableWatch!.planId, durableWatch!.unitId, assignmentId, final.status, watched.execution, receipt) : undefined };
            },
          });
          admission.commit();
          registerArchitectureRoom({ evaluation, roomId: team.teamId, toolCallId, director: { assignmentId, memberId: admission.memberId, instanceId: handle.instanceId } });
          recordTeamAssignment(evaluation, "architect", { id: assignmentId, instanceId: handle.instanceId, roleId: "architect", task: params.goal, dispatchId: handle.dispatchId });
          return result({ ...handle, roomId: team.teamId, assignmentId, memberId: admission.memberId });
        } catch (error) { admission.rollback(); throw error; }
      } catch (error) { return tableError(error); }
    },
  });
  pi.registerTool({ name: "architecture_read", label: "Read architecture consultation", description: "Read an immutable diagnostic cut, including snapshot, members, failures, pending, closure and delivery. Start with section (default report), maxBytes 4096..16384 (default 16384); continue with cursor only. A new start replaces only this room's cut. No acknowledgement or protocol advancement.",
    parameters: Type.Object({ roomId: text, ...tableReadProperties }, strict),
    execute: protect(async (_id, params, _signal, _update, ctx) => {
      const room = roomFor(params.roomId, ctx);
      return readTableDiagnostic(room.evaluation.token, room.instanceId, params as TableRead);
    }),
  });
  pi.registerTool({ name: "architecture_control", label: "Control architecture consultation", description: "Supply next-boundary context or priorities, finish after the current exchange, or revoke immediately with stop. Stop is not proof of closure.",
    parameters: Type.Object({ roomId: text, action: Type.Union([Type.Literal("context"), Type.Literal("priorities"), Type.Literal("finish"), Type.Literal("stop")]), text: Type.Optional(text) }, strict),
    execute: protect(async (toolCallId, params, _signal, _update, ctx) => {
      assertNoCheckpointLease(ctx.cwd, true);
      const room = roomFor(params.roomId, ctx);
      if (!room.runtime) {
        if (params.action !== "stop") throw new Error("architecture preparation pending");
        cancelTeamWorker(room.evaluation.token, room.instanceId);
        const id = architectureControl(room, params.action, params.text, toolCallId);
        architectureControlApplied(room, [id], null, 0);
        return result({ roomId: params.roomId, state: "stopping" });
      }
      return result(room.runtime.control(params.action, params.text, toolCallId));
    }),
  });
}
