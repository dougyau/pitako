import path from "node:path";
import { registerArchitecture } from "../architecture/index.ts";
import { registerReview } from "../review/index.ts";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PitakoConfigError } from "../errors.ts";
import { assertIndividualRole, TABLE_ONLY_ROLES } from "../roles/types.ts";
import {
  backgroundExecutor,
  cancelWorker,
  formatWorkerHandle,
  formatWorkerViews,
  interestFrom,
  reserveBackground,
  workerResult,
  workerStatus,
  teamWorkerStatus,
  teamWorkerResult,
  teamWorkerHasOutcome,
  cancelTeamWorker,
  workerHandoff,
  consultationFeedback,
} from "./background.ts";
import { feedbackSchema } from "./consultation-feedback.ts";
import { consultationSnapshot, consultationRecord, prepareConsultation, isConsultation, reasoningSchema } from "./consultation.ts";
import { listObservations, noteResultTaken, observationEpoch, publishObservation } from "./observe.ts";
import { currentInstanceId } from "./scope.ts";
import { createPiExecutor } from "./pi.ts";
import { verificationSchema } from "./head/gates.ts";
import { evidenceFile } from "../workflow.ts";
import { createHead, validateAgentMode } from "./head/admission.ts";
import { assertNoCheckpointLease } from "./head/checkpoint-lease.ts";
import { formatAgentResult, formatTeamExecutionSummary, runAgentInstance, teamExecutionSummary } from "./run.ts";
import { randomUUID } from "node:crypto";
import { isTableRoot, readTableResult, tableRootStatus } from "./background.ts";
import { tableReadProperties, tableIncidental, tableError, incidentalMetadata, sealPages, type SealedPages, type TableRead } from "../table/results.ts";
import { existsSync } from "node:fs";
import { openBoard } from "../board/store.ts";
import { boardWorkspace, currentWorkspace } from "../board/workspace.ts";
import { ledgerFile, openExecutionPlan, planFile, readFrozenPlan, readPlan, readExecutionBinding, verifyExecutionBinding, type ExecutionBinding, type PlanMeta } from "../workflow.ts";
import { captureCallContext, checkAuthority, guardDefinition, guardToolRegistrations, assertGenericWrite, planningSlot } from "../workflow-engine.ts";
import { teamEvaluationForSession, reserveTeamMember, recordTeamAssignment, recordPlanTeamWork, teamAssignments, selectTeamAssignments } from "../team.ts";
import type { HistoryOrigin } from "./history.ts";
import { queryHistory } from "./history-query.ts";
import { executionForSession } from "../execution-identity.ts";
import { developerPreflight } from "./routing.ts";
import { ownedDispatch, settlePendingDispatches } from "./dispatch.ts";
import { resolveOwnedLive, resolveOwnedWorkerRead } from "./owner.ts";
import { listCheckpoints, readCheckpoint } from "./checkpoints.ts";

const noExtra = { additionalProperties: false } as const;
const checkpointOrigin = Type.Object({ assignmentId: Type.String({ minLength: 1, maxLength: 128 }),
  checkpointId: Type.String({ minLength: 1, maxLength: 128 }), commit: Type.String({ minLength: 1, maxLength: 256 }) },
  { ...noExtra, description: "Explicit new asynchronous Developer Head continuation; host validates exact saved source/index/root and positive predecessor/contributor closure. Does not apply a commit or restore sessions, DAG, ledger or acceptance." });

function historyOrigin(
  source: HistoryOrigin["source"],
  ctx: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } },
  workbrief: string,
  toolCallId: string,
  execution?: ExecutionBinding,
  assignmentId?: string,
): HistoryOrigin {
  return {
    source, workbrief, toolCallId, assignmentId,
    coordinatorSessionId: ctx.sessionManager?.getSessionId?.(),
    coordinatorSessionFile: ctx.sessionManager?.getSessionFile?.(),
    ...(execution ? { execution: {
      executionRoot: execution.executionRoot,
      executionRef: `${execution.planId}@${execution.revision}:${execution.hash}`,
    } } : {}),
  };
}

export default function agentInstance(pi: ExtensionAPI): void {
  const controls = guardToolRegistrations(pi, "read");
  controls.registerTool({
    name: "agent_checkpoints", label: "Inspect local checkpoints",
    description: "Foreground read-only local Git checkpoint list/read in the current repository, independent of live Head state. Reports saved identities, current saved-path matches, checkout dirt and historical evidence/gaps separately. Does not apply or adopt source. Missing history, a ref or terminal status alone is not closure or acceptance.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("list"), assignmentId: Type.Optional(Type.String()) }, noExtra),
      Type.Object({ action: Type.Literal("read"), ...checkpointOrigin.properties }, noExtra),
    ]),
    async execute(_id, params, _signal, _update, ctx) {
      const blocked = childBlocked("agent_checkpoints");
      if (blocked) return blocked;
      try {
        const details = params.action === "list" ? listCheckpoints(ctx.cwd, params.assignmentId) : readCheckpoint(ctx.cwd, params);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  });
  let dispatchSessionId: string | undefined;
  pi.on?.("session_shutdown", async (_event, ctx) => {
    await settlePendingDispatches(dispatchSessionId ?? ctx?.sessionManager?.getSessionId?.());
  });
  pi.on?.("session_start", async (_event, ctx) => {
    await settlePendingDispatches(dispatchSessionId ?? ctx.sessionManager?.getSessionId?.());
    dispatchSessionId = ctx.sessionManager?.getSessionId?.();
  });
  const liveTarget = Type.Union([
    Type.Object({ kind: Type.Literal("background"), instanceId: Type.String({ maxLength: 256 }) }, noExtra),
    Type.Object({ kind: Type.Literal("team"), assignmentId: Type.String({ maxLength: 256 }) }, noExtra),
  ]);
  const liveFor = (target: import("./background.ts").LiveTarget, ctx: { sessionManager?: { getSessionId?: () => string | undefined } }) => {
    return resolveOwnedLive(target, ctx.sessionManager?.getSessionId?.()).handle;
  };
  controls.registerTool({
    name: "agent_observe", label: "Observe live worker",
    description: "Observe one exact active background instance or Team assignment: original WorkBrief, bounded ordered coalesced event activity, native history/session identity, interactions and persistence gaps. Default 50, max 200 events, 32KiB/page. after is the returned event cursor; briefOffset pages oversized WorkBriefs. Use agent_history for persisted native entries. Not a synchronous agent_run target.",
    parameters: Type.Object({ target: liveTarget, after: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), briefOffset: Type.Optional(Type.Integer({ minimum: 0 })) }, noExtra),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const page = { target: params.target, ...liveFor(params.target, ctx).observe(params) };
        return textResult(JSON.stringify(page), page);
      } catch (error) { return errorResult(String(error)); }
    },
  });
  controls.registerTool({
    name: "agent_input", label: "Input to live worker",
    description: "Foreground only: queue missing-context queries or in-scope steering through public steer on an observed exact historyId/sessionId. Delivered only at a later native steering boundary; never interrupts a running command. Returns a receipt, not an answer: queued is admission, handled is hook consumption, rejected is no accepted submission, unconfirmed preserves closure uncertainty. No commands, replacement, prompt stream or follow-up. Reobserve after native replacement. Candidate replies mention interactionId; adequacy is not judged.",
    parameters: Type.Object({ target: liveTarget, historyId: Type.String({ maxLength: 256 }), sessionId: Type.String({ maxLength: 256 }),
      intent: Type.Union([Type.Literal("query"), Type.Literal("steer")]), text: Type.String({ minLength: 1 }),
      decisionId: Type.Optional(Type.String({ maxLength: 256 })) }, noExtra),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const receipt = { target: params.target, ...await liveFor(params.target, ctx).input(params) };
        return textResult(JSON.stringify(receipt), receipt);
      } catch (error) {
        const receipt = { target: params.target, historyId: params.historyId, sessionId: params.sessionId, status: "rejected", reason: String(error) };
        return { ...textResult(JSON.stringify(receipt), receipt), isError: true };
      }
    },
  });
  controls.registerTool({
    name: "agent_history",
    label: "Agent history",
    description: "Read-only local native histories, including all recorded branches and tool results. list defaults to this coordinator; explicit identity filters or scope all discover older groups. Members carry group identity and historyId. read source defaults to worker; coordinator resolves only its captured catalog session. Returns lossless base64 byte fragments in physical append order, not active context. Default 50, max 200 items, max 32KiB per page. Use the returned cursor until null; upstream truncation and external artifacts remain limits. No prune action or file/store paths.",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("list"),
        scope: Type.Optional(Type.Literal("all")),
        coordinatorSessionId: Type.Optional(Type.String()),
        missionId: Type.Optional(Type.String()),
        assignmentId: Type.Optional(Type.String()),
        instanceId: Type.Optional(Type.String()),
        roleId: Type.Optional(Type.String()),
        cursor: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }, noExtra),
      Type.Object({
        action: Type.Literal("read"),
        historyId: Type.Optional(Type.String()),
        dispatchId: Type.Optional(Type.String({ description: "Read the captured caller for one consultation, including no-worker outcomes" })),
        source: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("coordinator"), Type.Literal("caller")])),
        groupId: Type.Optional(Type.String()),
        cursor: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }, noExtra),
    ]),
    async execute(_id, params, _signal, _update, ctx) {
      const blocked = childBlocked("agent_history");
      if (blocked) return blocked;
      if (executionForSession(ctx.sessionManager?.getSessionId?.())) return errorResult("agent_history cannot be called from an AgentInstance");
      const page = await queryHistory(params, ctx.sessionManager?.getSessionId?.());
      return textResult(JSON.stringify(page), page);
    },
  });
  controls.registerTool({
    name: "consultation_feedback", label: "Consultation feedback",
    description: "Voluntary attributed assessment after the exact outcome is incorporated in your current branch. Corrections retain history. Optional followupInstances must be owned catalog runs; links show association, not cause. Never review, verification or acceptance.",
    parameters: feedbackSchema,
    async execute(_id, params, _signal, _update, ctx) {
      if (currentInstanceId() || executionForSession(ctx.sessionManager?.getSessionId?.())) return errorResult("consultation_feedback is foreground or granted Head only");
      try { const result = consultationFeedback(params, ctx.sessionManager?.getSessionId?.(), ctx.sessionManager); return textResult(JSON.stringify(result), result); }
      catch (error) { return errorResult(String(error)); }
    },
  });
  registerBackgroundTools(pi);
  registerTeamTools(pi);
  registerArchitecture(pi);
  registerReview(pi);
  // Dispatch owns its effects in the backend; validate the native caller without
  // a second generic writer. Preserve the dispatch error result on owner loss.
  pi.registerTool(guardDefinition({
    name: "agent_run",
    label: "Run agent",
    description:
      "Run one individual Pitako role in an isolated context. Architect and Reviewer require architecture_start and review_start. Returns the final result and model provenance, not the child transcript. If this fails, report the failure. Do not perform that role yourself.",
    promptSnippet: "Run an isolated Pitako role and return its final result",
    promptGuidelines: [
      "Use agent_run for Developer. Architect and Reviewer require architecture_start and review_start. Scout, Researcher and Oracle require agent_spawn or team_assign. If agent_run fails, report the error. Do not do that role's work in the parent session.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ not: { enum: Object.keys(TABLE_ONLY_ROLES) }, description: "Individual role id, for example developer; Architect/Reviewer require architecture_start/review_start" }),
        task: Type.String({ description: "Explicit task for the isolated agent" }),
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (currentInstanceId()) {
        return errorResult("agent_run cannot be called from an AgentInstance");
      }
      try {
        assertGenericWrite(captureCallContext(ctx.cwd, ctx.sessionManager));
        assertIndividualRole(params.role);
        if (isConsultation(params.role)) throw new Error("Consultative roles require agent_spawn or team_assign, not agent_run");
        validateAgentMode(params, ctx.cwd, false);
        let live = "";
        const epoch = observationEpoch();
        let dispatch: Awaited<ReturnType<typeof developerPreflight>> | undefined;
        let checkDispatch: (() => void) | undefined;
        if (params.role === "developer") {
          dispatch = await ownedDispatch(ctx, signal, () => true, async (signal, check) => {
            checkDispatch = check;
            const snapshot = await developerPreflight({ task: params.task, toolCallId: _toolCallId,
              source: "agent_run", ctx, pi, signal, owns: () => { check(); return true; } });
            check();
            return snapshot;
          });
        }
        const origin = historyOrigin("agent_run", ctx, params.task, _toolCallId);
        if (dispatch) {
          origin.routing = dispatch.routing;
          origin.routingEvidence = { state: dispatch.evidence, gap: dispatch.evidenceGap };
        }
        checkDispatch?.();
        const result = await runAgentInstance({
          roleId: params.role,
          task: params.task,
          cwd: ctx.cwd,
          signal,
          executor: createPiExecutor(),
          historyOrigin: origin,
          dispatch,
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
          details: { ...result, live, ...(dispatch ? { dispatchId: dispatch.routing.dispatchId,
            routingEvidence: origin.routingEvidence } : {}) },
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
  }, "read", false, (): ReturnType<typeof textResult> => errorResult("Dispatch cancelled before admission")));
}

function registerTeamTools(pi: ExtensionAPI): void {
  let statusCut: { evaluation: NonNullable<ReturnType<typeof teamEvaluationForSession>>; pages: SealedPages } | undefined;
  const roles = ["developer", "researcher", "scout", "oracle"] as const;
  const evaluationFor = (ctx: { sessionManager?: { getSessionId?: () => string | undefined } }) =>
    teamEvaluationForSession(
      typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
      Boolean(currentInstanceId() || process.env.PITAKO_INSTANCE_ID),
    );
  const findAssignment = (evaluation: NonNullable<ReturnType<typeof teamEvaluationForSession>>, id: string) => {
    const assignment = teamAssignments(evaluation).find((item) => item.id === id);
    if (!assignment) throw new Error(`unknown Team assignment ${id}`);
    return assignment;
  };

  pi.registerTool(guardDefinition({
    name: "team_assign",
    label: "Assign Team role",
    description: "Start one isolated individual Team role. Architect and Reviewer require architecture_start and review_start. Returns immediately. Each call admits an independently identified member, including the same role. Every asynchronous developer mode head with explicit writes has local checkpoints and supports explicit checkpoint_origin continuation; neither grants publication or acceptance.",
    promptSnippet: "Assign independent work to a Team role",
    promptGuidelines: ["Use team_assign for independent long work. Keep task scoped. Do not wait or poll; interpret complete results automatically supplied in context. team_result is an optional diagnostic re-read, not a transport or acknowledgement."],
    parameters: Type.Object({
      role: Type.String({ enum: [...roles] }),
      task: Type.String({ minLength: 1, description: "Scoped WorkBrief for this role" }),
      plan: Type.Optional(Type.String()),
      unit: Type.Optional(Type.String()),
      boardTopicId: Type.Optional(Type.String({ description: "Existing Board topic ID; no topic is created" })),
      mode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("head")])),
      writes: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
      checkpoint_origin: Type.Optional(checkpointOrigin),
      verification: verificationSchema,
      reasoning: reasoningSchema,
    }, noExtra),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        assertGenericWrite(captureCallContext(ctx.cwd, ctx.sessionManager));
        assertIndividualRole(params.role);
        if (signal?.aborted || !params.task.trim()) throw new Error("Dispatch cancelled or empty task");
        const headOptions = validateAgentMode(params, ctx.cwd);
        if (headOptions) assertNoCheckpointLease(ctx.cwd);
        let consultation = consultationSnapshot(params.role, params.reasoning, ctx.cwd);
        const caller = ctx.sessionManager;
        const evaluation = evaluationFor(ctx);
        const id = randomUUID();
        const admission = reserveTeamMember(evaluation, params.role, id);
        const origin = { ...historyOrigin("team_assign", ctx, params.task, _toolCallId, undefined, id),
          teamId: admission.teamId, memberId: admission.memberId };
        const callerOwns = () => admission.owns() && ctx.sessionManager?.getSessionId?.() === origin.coordinatorSessionId &&
          ctx.sessionManager?.getSessionFile?.() === origin.coordinatorSessionFile;
        let head: ReturnType<typeof createHead>;
        let durableWatch: { planId: string; unitId: string; execution?: ExecutionBinding } | undefined;
        try {
          const captured = captureTeamWatch(params, ctx);
          const reservationRoot = captured.execution?.executionRoot ?? ctx.cwd;
          const handle = reserveBackground({ roleId: params.role, coordinatorSessionId: origin.coordinatorSessionId, task: params.task, origin,
            cwd: reservationRoot, context: captureCallContext(reservationRoot, ctx.sessionManager), watch: captured.watch ? { ...captured.watch, execution: captured.execution } : undefined,
            owns: callerOwns,
            teamOwner: { token: admission.token, assignmentId: id, teamId: admission.teamId, memberId: admission.memberId, onSettled: () => admission.settled(), noWorkerReleased: admission.noWorkerReleased },
            async cleanup() {
              await head?.close();
              if (durableWatch) recordPlanTeamWork(ctx.cwd, durableWatch.planId, durableWatch.unitId, id, undefined, durableWatch.execution);
            },
            async prepare(signal, check, reserved) {
              if (consultation) {
              const record = consultationRecord(pi, ctx, origin, reserved.dispatchId, reserved.instanceId, consultation, reserved.current, undefined, caller);
              reserved.record(record);
              consultation = await prepareConsultation(consultation, params.task, ctx, signal, check, record);
            }
              check();
              const watched = await prepareTeamWatch(params, ctx, id, check, async () =>
                params.role === "developer" && !headOptions ? developerPreflight({
                  task: params.task, toolCallId: _toolCallId, source: "team_assign", ctx, pi, signal,
                  owns: () => { check(); return true; },
                }) : undefined, captured);
              const { watch, execution, topic, preflight: dispatch } = watched;
              durableWatch = watched.durableWatch;
              check();
              const task = [`Team assignment header: Team ${admission.teamId}; member ${admission.memberId}; role ${params.role}; assignment ${id}${topic !== undefined ? `; Board topic ${topic}` : ""}.`,
                "WorkBrief:", params.task.trim()].join("\n");
              const launchRoot = execution?.executionRoot ?? ctx.cwd;
              head = createHead(id, launchRoot, headOptions, backgroundExecutor(), execution ? path.join(path.dirname(evidenceFile(execution.planId, "gates", launchRoot)), `gates-${id}`) : undefined);
              if (execution) origin.execution = { executionRoot: execution.executionRoot, executionRef: `${execution.planId}@${execution.revision}:${execution.hash}` };
              if (dispatch) { origin.routing = dispatch.routing; origin.routingEvidence = { state: dispatch.evidence, gap: dispatch.evidenceGap }; }
              check();
              recordTeamAssignment(evaluation!, params.role, { id, instanceId: reserved.instanceId, roleId: params.role,
                task: params.task.trim(), planId: watch?.planId, unitId: watch?.unitId, boardTopicId: topic, execution, dispatchId: reserved.dispatchId });
              return { roleId: params.role, task, cwd: launchRoot, watch: watch ? { ...watch, execution } : undefined,
                executor: backgroundExecutor(), historyOrigin: origin, dispatch, consultation, head,
                reconcileBookkeeping: durableWatch
                  ? (result, receipt) => recordPlanTeamWork(launchRoot, durableWatch!.planId, durableWatch!.unitId, id, result.status, execution, receipt) : undefined };
            },
          });
          admission.commit();
          const assignment = { id, assignmentId: id, teamId: admission.teamId, memberId: admission.memberId, ordinal: admission.ordinal, admittedAt: admission.admittedAt, instanceId: handle.instanceId, roleId: params.role, task: params.task.trim(), dispatchId: handle.dispatchId };
          recordTeamAssignment(evaluation!, params.role, assignment);
          return textResult(`assignment_id: ${id}\n${formatWorkerHandle(handle)}`, { ...assignment, ...handle });
        } catch (error) { admission.rollback(); throw error; }
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  }, "read", false, (): ReturnType<typeof textResult> => errorResult("Dispatch cancelled before admission")));

  guardToolRegistrations(pi, "read").registerTool({
    name: "team_status",
    label: "Team status",
    description: "Show Team members in admission order. Does not wait or include task text or transcripts.",
    promptSnippet: "Inspect Team assignments without waiting",
    parameters: Type.Object({ assignmentId: Type.Optional(Type.String({ minLength: 1 })), teamId: Type.Optional(Type.String({ minLength: 1 })), memberId: Type.Optional(Type.String({ minLength: 1 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let tableRequest = false;
      try {
        const evaluation = evaluationFor(ctx);
        if (!evaluation) throw new Error("Team requires a foreground session identity");
        if (params.cursor !== undefined) {
          tableRequest = true;
          if (params.assignmentId !== undefined || params.teamId !== undefined || params.memberId !== undefined)
            throw new Error("status cursor cannot be combined with selectors");
          if (!statusCut || statusCut.evaluation.token !== evaluation.token || statusCut.evaluation.sessionId !== evaluation.sessionId)
            throw new Error("unknown or retired status cut");
          return statusCut.pages.read({ cursor: params.cursor });
        }
        const selected = selectTeamAssignments(evaluation, params);
        // Fail closed while probing a singleton; generic aggregation is not a table request.
        tableRequest = selected.length === 1;
        const rows = selected.map(row => {
          const table = tableRootStatus(evaluation.token, row.instanceId);
          if (table) return table;
          tableRequest = false;
          const view = teamWorkerStatus(evaluation.token, row.instanceId)[0];
          const observation = listObservations(evaluation.token, evaluation.sessionId).find((item) => item.id === row.instanceId);
          return {
            role: row.roleId,
            teamId: row.teamId, memberId: row.memberId, ordinal: row.ordinal, admittedAt: row.admittedAt,
            assignmentId: row.id,
            instanceId: row.instanceId,
            task: row.task.split("\n").find((line) => line.trim())?.trim().slice(0, 100) ?? "",
            status: view?.status ?? "settled",
            model: observation?.modelLabel ?? observation?.selectedModel,
            reasoning: observation?.appliedReasoning ?? observation?.requestedReasoning,
            activity: observation?.activeTool,
            elapsedMs: view?.elapsedMs,
            resultAvailable: teamWorkerHasOutcome(evaluation.token, row.instanceId),
            handoff: workerHandoff(row.instanceId),
          };
        }).filter((row) => row !== undefined);
        if (params.assignmentId && rows.length === 0) throw new Error(`unknown Team assignment ${params.assignmentId}`);
        if (rows.some(row => "closure" in row && typeof row.closure === "string")) {
          tableRequest = true;
          const members = rows.map(row => incidentalMetadata(row));
          // The same formatter/envelope is measured, including content escaping and details.
          try { return tableIncidental({ members }); }
          catch (error) {
            if (!String(error).includes("exceeds budget")) throw error;
            const cut = sealPages({ kind: "team-status", acceptance: false, members });
            statusCut = { evaluation, pages: cut };
            return cut.read({ maxBytes: 4096 });
          }
        }
        return textResult(JSON.stringify(rows), { members: rows });
      } catch (error) { return tableRequest ? tableError(error) : errorResult(error instanceof Error ? error.message : String(error)); }
    },
  });

  guardToolRegistrations(pi, "read").registerTool({
    name: "team_result",
    label: "Team result",
    description: "Read a settled result. Ordinary assignments retain their complete diagnostic. Tables return bounded canonical fragments; read pertinent sections before dependent judgment. Start with section (default report) and maxBytes 4096..16384 (default 16384); continue with cursor only. Transport end is not completion or product acceptance. No acknowledgement.",
    promptSnippet: "Inspect a settled Team assignment result",
    parameters: Type.Object({ assignmentId: Type.String(), ...tableReadProperties }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paging = params.cursor !== undefined || params.section !== undefined || params.maxBytes !== undefined;
      let tableRequest = paging;
      try {
        const evaluation = evaluationFor(ctx);
        if (!evaluation) throw new Error("Team requires a foreground session identity");
        const assignment = findAssignment(evaluation, params.assignmentId);
        // A retired matched root must not escape through the legacy error envelope.
        tableRequest = true;
        if (isTableRoot(evaluation.token, assignment.instanceId)) return readTableResult(evaluation.token, assignment.instanceId, params as TableRead);
        tableRequest = paging;
        if (paging) throw new Error("table paging requires a table root");
        const result = teamWorkerResult(evaluation.token, assignment.instanceId);
        const handoff = workerHandoff(assignment.instanceId);
        const summary = teamExecutionSummary(assignment.id, result);
        const prefix = `${formatTeamExecutionSummary(summary)}\n\n`;
        const diagnostic = handoff?.bookkeepingDiagnostic ? `\n\nBookkeeping blocked: ${handoff.bookkeepingDiagnostic}` : "";
        return textResult(`${prefix}${result.result}${diagnostic}`, {
          teamId: assignment.teamId, memberId: assignment.memberId, assignmentId: assignment.id, instanceId: result.instanceId, role: result.role,
          status: result.status, model: result.model, usage: result.usage, summary, handoff, resultLength: result.result.length,
        }, result.status !== "completed" || handoff?.bookkeeping === "blocked");
      } catch (error) { return tableRequest ? tableError(error) : errorResult(error instanceof Error ? error.message : String(error)); }
    },
  });

  guardToolRegistrations(pi, "read").registerTool({
    name: "team_cancel",
    label: "Cancel Team assignment",
    description: "Cancel one Team assignment. Its member stays owned until physical closure.",
    promptSnippet: "Cancel one Team assignment without waiting",
    parameters: Type.Object({ assignmentId: Type.String() }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let ordinary = false;
      try {
        const evaluation = evaluationFor(ctx);
        if (!evaluation) throw new Error("Team requires a foreground session identity");
        const assignment = findAssignment(evaluation, params.assignmentId);
        ordinary = !isTableRoot(evaluation.token, assignment.instanceId);
        const view = cancelTeamWorker(evaluation.token, assignment.instanceId);
        if (!ordinary) return tableIncidental(tableRootStatus(evaluation.token, assignment.instanceId)!);
        return textResult(JSON.stringify({ assignmentId: assignment.id, ...view }), { assignmentId: assignment.id, ...view });
      } catch (error) { return ordinary ? errorResult(error instanceof Error ? error.message : String(error)) : tableError(error); }
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
  check?: () => void,
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
    check?.();
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
  check: () => void = () => {},
): Promise<void> {
  const board = await openBoard();
  try {
    check();
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
  // Managed admission cannot expose the legacy process-wide worker ports.
  // Observations supply candidates; the backend revalidates their live owner.
  const managedWorkers = (ctx: ExtensionContext): Set<string> | undefined => {
    if (captureCallContext(ctx.cwd, ctx.sessionManager).kind !== "managed") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const owned = new Set<string>();
    for (const row of listObservations(undefined, sessionId)) {
      if (!row.ownerToken) continue;
      try {
        resolveOwnedWorkerRead({ kind: "background", instanceId: row.id },
          { ownerToken: row.ownerToken, coordinatorSessionId: sessionId });
        owned.add(row.id);
      } catch { /* Retired or foreign observations confer no worker authority. */ }
    }
    return owned;
  };
  const requireManagedWorker = (id: string, ctx: ExtensionContext) => {
    const owned = managedWorkers(ctx);
    if (owned && !owned.has(id)) throw new Error(`unknown worker ${id}`);
  };
  pi.registerTool(guardDefinition({
    name: "agent_spawn",
    label: "Spawn agent",
    description:
      "Start one individual Pitako role in the background. Architect and Reviewer require architecture_start and review_start. Return its instance id while it is still running. Does not wait for the result. A failure is not permission to do that role in the parent. Every asynchronous developer mode head with explicit writes has local checkpoints and supports explicit checkpoint_origin continuation; neither grants publication or acceptance.",
    promptSnippet: "Start a background Pitako role and return before it finishes",
    promptGuidelines: [
      "Use agent_spawn for long specialist work while you stay available. Interpret complete results automatically supplied in context; agent_result is an optional diagnostic re-read. Do not poll. If it fails, report the error. Do not do that role yourself.",
    ],
    parameters: Type.Object(
      {
        role: Type.String({ not: { enum: Object.keys(TABLE_ONLY_ROLES) }, description: "Individual role id, for example developer; Architect/Reviewer require architecture_start/review_start" }),
        task: Type.String({ description: "Explicit task for the isolated agent" }),
        plan: Type.Optional(Type.String({ description: "Optional execution correlation; all settled results are delivered automatically" })),
        unit: Type.Optional(Type.String({ description: "Unit id paired with plan" })),
        mode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("head")])),
        writes: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
        checkpoint_origin: Type.Optional(checkpointOrigin),
        verification: verificationSchema,
        reasoning: reasoningSchema,
      },
      noExtra,
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const blocked = childBlocked("agent_spawn");
      if (blocked) return blocked;
      try {
        assertGenericWrite(captureCallContext(ctx.cwd, ctx.sessionManager));
        assertIndividualRole(params.role);
        if (signal?.aborted || !params.task.trim()) throw new Error("Dispatch cancelled or empty task");
        const headOptions = validateAgentMode(params, ctx.cwd);
        if (headOptions) assertNoCheckpointLease(ctx.cwd);
        let consultation = consultationSnapshot(params.role, params.reasoning, ctx.cwd);
        const caller = ctx.sessionManager;
        const origin = historyOrigin("agent_spawn", ctx, params.task, _toolCallId);
        let head: ReturnType<typeof createHead>;
        const captured = captureTeamWatch(params, ctx);
        const reservationRoot = captured.execution?.executionRoot ?? ctx.cwd;
        const handle = reserveBackground({ roleId: params.role, coordinatorSessionId: origin.coordinatorSessionId, task: params.task, origin,
          cwd: reservationRoot, context: captureCallContext(reservationRoot, ctx.sessionManager), watch: captured.watch ? { ...captured.watch, execution: captured.execution } : undefined,
          owns: () => ctx.sessionManager?.getSessionId?.() === origin.coordinatorSessionId &&
            ctx.sessionManager?.getSessionFile?.() === origin.coordinatorSessionFile,
          async cleanup() { await head?.close(); },
          async prepare(signal, check, reserved) {
            if (captured.error) throw new Error(captured.error);
            if (consultation) {
              const record = consultationRecord(pi, ctx, origin, reserved.dispatchId, reserved.instanceId, consultation, reserved.current, undefined, caller);
              reserved.record(record);
              consultation = await prepareConsultation(consultation, params.task, ctx, signal, check, record);
            }
            check();
            const { watch, execution } = captured;
            if (execution) verifyExecutionBinding(execution);
            const launchRoot = execution?.executionRoot ?? ctx.cwd;
            const assignmentId = randomUUID();
            head = createHead(assignmentId, launchRoot, headOptions, backgroundExecutor(), execution ? path.join(path.dirname(evidenceFile(execution.planId, "gates", launchRoot)), `gates-${assignmentId}`) : undefined);
            const dispatch = params.role === "developer" && !head ? await developerPreflight({
              task: params.task, toolCallId: _toolCallId, source: "agent_spawn", ctx, pi, signal,
              owns: () => { check(); return true; },
            }) : undefined;
            check();
            if (execution) origin.execution = { executionRoot: execution.executionRoot, executionRef: `${execution.planId}@${execution.revision}:${execution.hash}` };
            if (dispatch) { origin.routing = dispatch.routing; origin.routingEvidence = { state: dispatch.evidence, gap: dispatch.evidenceGap }; }
            return { roleId: params.role, task: params.task, cwd: launchRoot,
              watch: watch ? { ...watch, execution } : undefined, executor: backgroundExecutor(), historyOrigin: origin,
              dispatch, consultation, head };
          },
        });
        return textResult(formatWorkerHandle(handle), handle);
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  }, "read", false, (): ReturnType<typeof textResult> => errorResult("Dispatch cancelled before admission")));

  guardToolRegistrations(pi, "read").registerTool({
    name: "agent_status",
    label: "Agent status",
    description: "Return compact background worker status. Does not wait for completion and does not include the result.",
    promptSnippet: "Inspect background workers without waiting",
    promptGuidelines: ["Use agent_status to see who is running. Do not poll it in a loop."],
    parameters: Type.Object(
      { id: Type.Optional(Type.String({ description: "Instance id. Omit to list every worker." })) },
      noExtra,
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blocked = childBlocked("agent_status");
      if (blocked) return blocked;
      try {
        const owned = managedWorkers(ctx);
        if (params.id) requireManagedWorker(params.id, ctx);
        const views = workerStatus(params.id).filter(row => !owned || owned.has(row.instanceId));
        return textResult(formatWorkerViews(views), { workers: views });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  guardToolRegistrations(pi, "read").registerTool({
    name: "agent_result",
    label: "Agent result",
    description:
      "Optional complete, idempotent diagnostic re-read of a settled background worker result. Does not acknowledge automatic handoff or wait. A failure is not permission to do that role in the parent.",
    promptSnippet: "Inspect a settled background worker result",
    promptGuidelines: ["Interpret automatically supplied results. Use agent_result only for diagnostics; do not poll or acknowledge collection."],
    parameters: Type.Object({ id: Type.String({ description: "Instance id" }) }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blocked = childBlocked("agent_result");
      if (blocked) return blocked;
      try {
        requireManagedWorker(params.id, ctx);
        const result = workerResult(params.id);
        return textResult(formatAgentResult(result), result, result.status !== "completed");
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });

  guardToolRegistrations(pi, "read").registerTool({
    name: "agent_cancel",
    label: "Cancel agent",
    description: "Cancel one background worker. Does not wait for the run to finish. Does not cancel other workers.",
    promptSnippet: "Cancel one background worker",
    promptGuidelines: ["Use agent_cancel only for the worker you intend to stop."],
    parameters: Type.Object({ id: Type.String({ description: "Instance id" }) }, noExtra),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blocked = childBlocked("agent_cancel");
      if (blocked) return blocked;
      try {
        requireManagedWorker(params.id, ctx);
        const view = cancelWorker(params.id);
        return textResult(formatWorkerViews([view]), view);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

/** Shared root admission rules. Internal protocol turns never call this helper. */
export function captureTeamWatch(params: { plan?: string; unit?: string }, ctx: ExtensionContext) {
  let watch = interestFrom(params.plan, params.unit);
  try {
  const context = captureCallContext(ctx.cwd, ctx.sessionManager);
  if (context.kind === "managed" && checkAuthority(context.authority).run.phase === "planning") {
    const slot = planningSlot(context.authority), snapshot = slot.read();
    if (params.plan !== undefined && params.plan !== slot.id) throw new Error("planning watch must use the captured slot");
    if (!snapshot.meta || snapshot.meta.status !== "draft") throw new Error("planning table requires a bound draft");
    watch = interestFrom(slot.id, params.unit ?? "planning");
    const plan = { file: snapshot.file, text: snapshot.text!, meta: snapshot.meta };
    return { watch, plan, execution: undefined, planning: { slot, snapshot }, error: undefined };
  }
  const saved = watch ? readExecutionBinding(watch.planId, ctx.cwd) : undefined;
  const plan = watch ? saved ? verifyExecutionBinding(saved) : assignmentPlan(watch.planId, ctx.cwd) : undefined;
  const execution = saved ?? (plan?.meta.status === "frozen" ? {
    planId: plan.meta.id, revision: plan.meta.revision, hash: plan.meta.hash,
    executionRoot: currentWorkspace(ctx.cwd), planSource: plan.file,
  } : undefined);
  if (execution) verifyExecutionBinding(execution);
  return { watch, plan, execution, error: undefined };
  } catch (error) {
    return { watch: watch && { ...watch, unavailable: String(error) }, plan: undefined, execution: undefined, error: String(error) };
  }
}
export async function prepareTeamWatch<T = undefined>(params: { plan?: string; unit?: string; boardTopicId?: string }, ctx: ExtensionContext, id: string, check: () => void,
  beforeCommit?: () => Promise<T>, captured = captureTeamWatch(params, ctx)) {
  const { watch } = captured;
  if (captured.error) throw new Error(captured.error);
  let { plan, execution } = captured;
  if ("planning" in captured && captured.planning) captured.planning.slot.read();
  if (execution) verifyExecutionBinding(execution);
  const topic = await teamBoardTopic(params.boardTopicId, watch?.planId, ctx.cwd, plan?.meta, check);
  check();
  if ("planning" in captured && captured.planning) captured.planning.slot.read();
  // Validate first, but never create a ledger or hold before routing has settled.
  const preflight = await beforeCommit?.();
  check();
  if (watch && plan?.meta.status === "frozen") {
    const opened = openExecutionPlan(watch.planId, ctx.cwd, { createLedger: true, source: plan });
    plan = opened; execution = opened.binding;
    if (topic !== undefined) await claimTeamBoardTopicExecution(topic, opened.meta, ctx.cwd, opened.binding.executionRoot, check);
    check();
  }
  const durableWatch = watch ? { ...watch, execution } : undefined;
  if (durableWatch) recordPlanTeamWork(ctx.cwd, durableWatch.planId, durableWatch.unitId, id, "pending", execution);
  return { watch, topic, execution, durableWatch, preflight };
}
