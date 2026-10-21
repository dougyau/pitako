import type { RecoveryScheduler } from "./agent/delivery.ts";
import { consultationStats } from "./agent/history-query.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { skillStatusLines } from "./catalog.ts";
import { PitakoConfigError } from "./errors.ts";
import { isProtectedEditPath } from "./paths.ts";
import { canonicalPath } from "./board/paths.ts";
import { bindBackgroundOwner, revokeBackgroundOwner, shutdownBackground, observeWorkerResults,
  draftWorkerResults, draftIntermediateResults, observeIntermediateResults, settleBackgroundResults, restrictWorkerContinuation, externallyStartedWorkerOwner } from "./agent/background.ts";
import { beginTeamEvaluation, retireTeamEvaluation, teamEvaluationForSession, teamAssignments, type TeamEvaluation } from "./team.ts";
import { teamWorkerStatus } from "./agent/background.ts";
import { bindAgentUi, listObservations, unbindAgentUi } from "./agent/observe.ts";
import { formatAgentsDetail } from "./agent/ui.ts";
import { childSessionNote, parseProfile, profileNote, setSessionProfile, effectiveProfile, requestedProfile, isChildSession, applyProfile, isOrchestrationTool } from "./profile.ts";
import { currentInstanceId } from "./agent/scope.ts";
import { executionForSession } from "./execution-identity.ts";
import { formatUsage, mergeUsage, type AgentUsage } from "./agent/run.ts";
import { inspectPitako } from "./roles/format.ts";
import { completePitakoConfig } from "./roles/complete.ts";
import { registerSupervisedSession, unregisterSupervisedSession } from "./herdr/author.ts";
import { registerAgentSupervise } from "./herdr/supervise.ts";
import { packageRoot, prepareRuntime } from "./stack.ts";
import { planHeading, planInvocation, sessionNameAction } from "./session-name.ts";
import { planFile, readFrozenPlan, readPlan } from "./workflow.ts";
import path from "node:path";
import type { ApplyPatchResult } from "pi-codex-tools";
import { parseHistoryCommand, queryHistory } from "./agent/history-query.ts";
import { WorkerHistory } from "./agent/history.ts";
import { pruneWorkerHistory } from "./agent/history-retention.ts";
import { loadPitakoConfig } from "./roles/load.ts";
import { closeDispatchAdmissions, settlePendingDispatches } from "./agent/dispatch.ts";
import { createAgentController } from "./agent/controller.ts";
import { openAgentScreen } from "./agent/screen.ts";
import { createPaneSession } from "./herdr/agents-ui/session.ts";
import { readHerdrPresence } from "./herdr/presence.ts";
import { createAgentBridge } from "./agent/bridge/broker.ts";
import { AgentClosureError } from "./agent/closure.ts";
import { principalLeases } from "./agent/head/operation-leases.ts";
import { foregroundBash } from "./agent/head/managed-tools.ts";
import { registerWorkflowCommands } from "./workflow-engine.ts";

function foregroundSession(sessionId: string | undefined): sessionId is string {
  return Boolean(sessionId && !executionForSession(sessionId) && !currentInstanceId() && !process.env.PITAKO_INSTANCE_ID);
}

function foregroundModelUsage(entries: readonly unknown[] | undefined): string {
  if (!entries) return "model usage: unknown (session entries unavailable)";
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let found = false;
  const add = (usage: any) => {
    if (!usage || typeof usage !== "object" || (!["input", "output", "cacheRead", "cacheWrite"].some((key) => typeof usage[key] === "number") && typeof usage.cost?.total !== "number")) return;
    found = true;
    totals.input += Number(usage.input) || 0;
    totals.output += Number(usage.output) || 0;
    totals.cacheRead += Number(usage.cacheRead) || 0;
    totals.cacheWrite += Number(usage.cacheWrite) || 0;
    totals.cost += Number(usage.cost?.total) || 0;
  };
  for (const entry of entries as any[]) {
    if (entry?.type === "usage") add(entry.usage);
    else if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) add(entry.usage);
    else if (entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) add(entry.message.usage);
  }
  if (!found) return "model usage: unknown (no usage reported)";
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return `model usage: input=${totals.input}, output=${totals.output}, cached_read=${totals.cacheRead}, cached_write=${totals.cacheWrite}, total=${total}, cost=${totals.cost}`;
}

export default function pitako(pi: ExtensionAPI, host: { recoveryScheduler?: RecoveryScheduler } = {}) {
  const root = packageRoot();
  // Fail during extension load so Pi surfaces a configuration error at startup.
  prepareRuntime(root);

  principalLeases(pi, foregroundBash);
  const retireWorkflow = registerWorkflowCommands(pi, { shutdown: false });

  pi.registerFlag("pitako-profile", {
    description: 'Pitako profile: "coding" (default) or "analysis"',
    type: "string",
  });
  pi.registerFlag("pitako-agent-bridge", {
    description: "Optional foreground RPC agent bridge in a host-owned absolute private directory",
    type: "string",
  });

  registerAgentSupervise(pi);

  let ownerToken = Symbol("pitako.foreground");
  let agentUiBindingToken: symbol | undefined;
  let teamEvaluation: TeamEvaluation | undefined;
  let agentController: ReturnType<typeof createAgentController> | undefined;
  let agentPane: ReturnType<typeof createPaneSession> | undefined;
  let agentBridge: ReturnType<typeof createAgentBridge> | undefined;
  let foregroundRevision = 0;
  let retirement: Promise<void> = Promise.resolve();

  const revokeForeground = () => {
    ++foregroundRevision;
    const retired = { controller: agentController, pane: agentPane, bridge: agentBridge, token: ownerToken, evaluation: teamEvaluation };
    retired.controller?.revoke();
    retired.pane?.revoke();
    retired.bridge?.revoke();
    revokeBackgroundOwner(retired.token);
    agentController = undefined;
    agentPane = undefined;
    agentBridge = undefined;
    teamEvaluation = undefined;
    if (agentUiBindingToken) unbindAgentUi(agentUiBindingToken);
    agentUiBindingToken = undefined;
    return retired;
  };

  // Retain prior handles even after revokeForeground clears the live references.
  // Start closes synchronously to revoke Team authority before the first await.
  // allSettled observes every close, and a failed close poisons this lifetime.
  const retainRetirement = (retired: ReturnType<typeof revokeForeground>, sessionId?: string, closeWorkflow?: () => Promise<void>) => {
    const previous = retirement;
    retirement = Promise.allSettled([
      previous,
      ...[
        () => retireTeamEvaluation(retired.evaluation), () => shutdownBackground(retired.token),
        () => settlePendingDispatches(sessionId), () => retired.controller?.settle(),
        () => retired.pane?.close(), () => retired.bridge?.settle(), () => closeWorkflow?.(),
      ].map(async close => close()),
    ]).then(results => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AgentClosureError(failures, "Foreground retirement");
    });
    void retirement.catch(() => {});
    return retirement;
  };

  pi.on("session_start", async (_event, ctx) => {
    const retired = revokeForeground();
    const revision = foregroundRevision;
    const manager = ctx.sessionManager;
    const sessionId = manager?.getSessionId();
    const current = () => revision === foregroundRevision && manager === ctx.sessionManager && sessionId === manager?.getSessionId();
    retired.evaluation ??= teamEvaluationForSession(sessionId, isChildSession(ctx));
    const retiringId = retired.evaluation?.sessionId ?? sessionId;
    const reopenDispatches = closeDispatchAdmissions(retiringId);
    const closed = retainRetirement(retired, retiringId);
    let settled = false;
    try {
      await closed;
      settled = true;
      if (!current()) return;
      if (foregroundSession(sessionId) && !isChildSession(ctx)) {
        const completion = completePitakoConfig({ cwd: ctx.cwd }, current);
        if (completion.state === "skipped") {
          if (ctx.hasUI) ctx.ui.notify(completion.warning, "warning"); else console.warn(completion.warning);
        }
        if (!current()) return;
      }
      if (foregroundSession(sessionId)) {
        // Cooperative history maintenance never waits for or cancels a worker.
        try {
          const result = await pruneWorkerHistory(new WorkerHistory(undefined, { initialize: false }), loadPitakoConfig({ cwd: ctx.cwd }).workerHistory.ttlDays);
          const failures = result.groups.filter((group) => group.state === "failed");
          if (failures.length) {
            const message = `Worker history maintenance failed: ${JSON.stringify(failures)}`;
            if (ctx.hasUI) ctx.ui.notify(message, "error"); else console.error(message);
          }
        } catch (error) {
          const message = `Worker history maintenance failed: ${String(error)}`;
          if (ctx.hasUI) ctx.ui.notify(message, "error"); else console.error(message);
        }
        if (!current()) return;
      }
      const profile = isChildSession(ctx) ? executionForSession(sessionId)?.profile ?? "coding" : requestedProfile(pi);
      if (manager) setSessionProfile(manager, profile, current);
      applyProfile(pi, ctx);
      ownerToken = Symbol("pitako.foreground");
      teamEvaluation = beginTeamEvaluation(
        sessionId,
        isChildSession(ctx),
        ownerToken,
      );
      if (!isChildSession(ctx) && sessionId) {
        const token = ownerToken;
        agentController = createAgentController({ sessionId, token }, () => {
          const currentId = ctx.sessionManager?.getSessionId();
          return currentId ? { sessionId: currentId, token: ownerToken } : undefined;
        });
        agentPane = createPaneSession(agentController, readHerdrPresence(), path.join(packageRoot(), "extensions/herdr/agents-ui"));
      }
      registerSupervisedSession(sessionId, process.env, pi, ctx.model);
      if (!isChildSession(ctx) && typeof ctx.isIdle === "function") {
        const token = ownerToken;
        const evaluationToken = teamEvaluation?.token;
        const owns = () => revision === foregroundRevision && token === ownerToken &&
          sessionId === ctx.sessionManager?.getSessionId() && evaluationToken === teamEvaluation?.token &&
          (!evaluationToken || teamEvaluationForSession(sessionId, false)?.token === evaluationToken);
        bindBackgroundOwner({
          token, sessionId, revision, owns, recoveryScheduler: host.recoveryScheduler,
          isIdle: () => ctx.isIdle(),
          hasUI: ctx.hasUI,
          notify: (message) => {
            if (ctx.hasUI) ctx.ui.notify(message, "info");
          },
          sendMessage: (content, source) => {
            if (!owns()) return;
            source.assertIssued();
            pi.sendMessage(
              {
                customType: "pitako.worker",
                content,
                display: true,
                details: { source: "pitako.worker" },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          },
          appendIntermediate: message => {
            if (owns()) pi.sendMessage(message, { triggerTurn: false });
          },
          appendResult: message => {
            if (owns()) pi.sendMessage(message, { triggerTurn: false });
          },
          getBranch: () => owns() ? ctx.sessionManager.getBranch() : [],
        });
      }
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      const existingUserText = firstUserText(entries);
      const invocation = latestPlanInvocation(entries);
      const workflow = invocation && readWorkflowTitle(invocation.activity, invocation.id, ctx.cwd);
      const action = sessionNameAction({ current: pi.getSessionName(), existingUserText, workflow });
      if (action.set !== undefined) pi.setSessionName(action.set);
      if (ctx.hasUI) {
        ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);
        agentUiBindingToken = bindAgentUi({
          ownerToken,
          coordinatorSessionId: sessionId,
          setStatus: (key, text) => ctx.ui.setStatus(key, text),
          modelLookup: (provider, id) => ctx.modelRegistry?.find(provider, id),
        });
      }
      const bridgeRoot = pi.getFlag("pitako-agent-bridge");
      if (!isChildSession(ctx) && ctx.mode === "rpc" && bridgeRoot !== undefined) {
        if (typeof bridgeRoot !== "string" || !bridgeRoot.length)
          throw new Error("Agent bridge requires an absolute private directory");
        if (agentController && current()) {
          const lifetime = createAgentBridge(agentController, bridgeRoot, current);
          agentBridge = lifetime;
          await lifetime.ready;
          if (!current()) {
            if (revision === foregroundRevision) throw new Error("Foreground session retired during publication");
            return;
          }
        }
      }
    } catch (error) {
      // Failed retirement published nothing. Only this revision may clean its partial publication.
      if (settled && revision === foregroundRevision) {
        const partial = revokeForeground();
        const cleanup = retainRetirement(partial, sessionId);
        try { await cleanup; }
        catch (failure) { settled = false; throw new AgentClosureError([error, failure], "Foreground publication"); }
      }
      throw error;
    } finally {
      // An uncertain close retains its lease for the lifetime, not just this event.
      if (settled) reopenDispatches();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const retired = revokeForeground();
    const revision = foregroundRevision;
    retired.evaluation ??= teamEvaluationForSession(ctx.sessionManager?.getSessionId(), isChildSession(ctx));
    const sessionId = retired.evaluation?.sessionId ?? ctx.sessionManager?.getSessionId();
    const reopenDispatches = closeDispatchAdmissions(sessionId);
    // Serial event dispatch must start both fences before any retirement suspends.
    await retainRetirement(retired, sessionId, retireWorkflow);
    reopenDispatches();
    if (revision === foregroundRevision) unregisterSupervisedSession();
  });

  const ownsEvent = (ctx: ExtensionContext) => foregroundSession(ctx?.sessionManager?.getSessionId()) &&
    ctx.sessionManager.getSessionId() === teamEvaluation?.sessionId &&
    teamEvaluationForSession(teamEvaluation.sessionId, false)?.token === teamEvaluation.token &&
    teamEvaluation.token === ownerToken;
  const terminal = (_event: unknown, ctx: ExtensionContext) => {
    if (ownsEvent(ctx)) settleBackgroundResults(ownerToken, true);
  };
  pi.on("agent_before_settle", (event, ctx) => {
    if (!ownsEvent(ctx)) return;
    const terminal = draftWorkerResults(ownerToken, event.outcome);
    const intermediate = draftIntermediateResults(ownerToken, event.outcome);
    if (terminal || intermediate) return { entries: [...terminal?.entries ?? [], ...intermediate?.entries ?? []],
      continue: !!(terminal?.continue || intermediate?.continue) };
  });
  pi.on("agent_settled", terminal);
  pi.on("session_compact", (event, ctx) => {
    if (!ownsEvent(ctx)) return;
    if (event.reason === "manual") settleBackgroundResults(ownerToken, true, false);
    else { observeWorkerResults(ownerToken); observeIntermediateResults(ownerToken); }
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (!ownsEvent(ctx)) return;
    if (event.reason === "manual") settleBackgroundResults(ownerToken, true, false);
    else { observeWorkerResults(ownerToken); observeIntermediateResults(ownerToken); }
  });
  pi.on("session_tree", (_event, ctx) => {
    if (ownsEvent(ctx)) settleBackgroundResults(ownerToken, true, false);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (ownsEvent(ctx)) { observeWorkerResults(ownerToken, true); observeIntermediateResults(ownerToken, true); }
  });
  pi.on("context", (_event, ctx) => {
    if (ownsEvent(ctx)) { observeWorkerResults(ownerToken, "context"); observeIntermediateResults(ownerToken, "context"); }
  });
  pi.on("message_end", (event, ctx) => {
    if (!ownsEvent(ctx)) return;
    if (event.message.role === "assistant") {
      if (event.message.stopReason === "aborted") restrictWorkerContinuation(ownerToken, "aborted");
      if (event.message.stopReason === "error") restrictWorkerContinuation(ownerToken, "error");
    }
    observeWorkerResults(ownerToken); observeIntermediateResults(ownerToken);
  });
  pi.on("agent_end", (event, ctx) => {
    if (!ownsEvent(ctx)) return;
    const last = [...event.messages].reverse().find(message => message.role === "assistant");
    if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error"))
      restrictWorkerContinuation(ownerToken, last.stopReason);
    if (ctx.signal?.aborted) restrictWorkerContinuation(ownerToken, "aborted");
    observeWorkerResults(ownerToken); observeIntermediateResults(ownerToken);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ownsEvent(ctx)) {
      externallyStartedWorkerOwner(ownerToken);
      observeWorkerResults(ownerToken); observeIntermediateResults(ownerToken);
    }
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const existingUserText = firstUserText(entries);
    const pendingPrompt = existingUserText ? undefined : event.prompt;
    const invocation = planInvocation(event.prompt);
    const workflow = invocation && readWorkflowTitle(invocation.activity, invocation.id, ctx.cwd);
    const action = sessionNameAction({
      current: pi.getSessionName(),
      existingUserText,
      pendingPrompt,
      workflow,
    });
    if (action.set !== undefined) pi.setSessionName(action.set);
    if (ctx.hasUI) ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);

    const instanceId = executionForSession(ctx.sessionManager?.getSessionId())?.instanceId ?? currentInstanceId() ?? process.env.PITAKO_INSTANCE_ID;
    const note = instanceId ? childSessionNote(instanceId) : profileNote(effectiveProfile(ctx.sessionManager));
    const current = event.systemPrompt ?? "";
    if (current.includes(note)) return undefined;
    return { systemPrompt: current.length > 0 ? `${current}\n\n${note}` : note };
  });
  pi.registerCommand("pitako", {
    description: "Pitako status, telemetry, profile, roles, and model policies",
    handler: async (args, ctx) => {
      const [command, value] = args.trim().split(/\s+/, 2);
      if (command === "history") {
        if (isChildSession(ctx)) { notify(ctx, "history cannot be called from an AgentInstance", "error"); return; }
        try {
          const historyArgs = args.trim().slice("history".length).trim();
          if (historyArgs.split(/\s+/)[0] === "prune") {
            if (!/^prune(?:\s+--dry-run)?$/.test(historyArgs)) throw new Error("usage: /pitako history prune [--dry-run]");
            const page = await pruneWorkerHistory(new WorkerHistory(undefined, { initialize: false }), loadPitakoConfig({ cwd: ctx.cwd }).workerHistory.ttlDays,
              { dryRun: historyArgs.includes("--dry-run") });
            notify(ctx, JSON.stringify(page));
            return;
          }
          const page = await queryHistory(parseHistoryCommand(historyArgs), ctx.sessionManager?.getSessionId?.());
          notify(ctx, JSON.stringify(page));
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "roles" || command === "role" || command === "policies" || command === "policy") {
        try {
          notify(ctx, inspectPitako(args));
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "team") {
        const evaluation = teamEvaluationForSession(
          ctx.sessionManager?.getSessionId?.(),
          isChildSession(ctx),
        );
        if (!evaluation) {
          notify(ctx, "Team unavailable for this session", "error");
          return;
        }
        const rows = teamAssignments(evaluation).map(assignment => {
          const view = teamWorkerStatus(evaluation.token, assignment.instanceId)[0];
          return {
            role: assignment.roleId,
            teamId: assignment.teamId, memberId: assignment.memberId, ordinal: assignment.ordinal,
            assignmentId: assignment.id,
            instanceId: assignment.instanceId,
            status: view?.status ?? "settled",
            elapsedMs: view?.elapsedMs,
          };
        });
        notify(ctx, JSON.stringify(rows));
        return;
      }
      if (command === "agents") {
        if (isChildSession(ctx)) { notify(ctx, "agents cannot be called from an AgentInstance", "error"); return; }
        try {
          const agentArgs = args.trim().slice("agents".length).trim();
          if (agentArgs.split(/\s+/)[0] === "pane") {
            if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Agent pane requires an interactive foreground Pi terminal");
            if (!agentPane) throw new Error("Agent pane controller unavailable");
            const args = agentArgs.split(/\s+/).slice(1);
            if (args.length === 1 && args[0] === "close") await agentPane.close();
            else {
              if (new Set(args).size !== args.length || args.some(arg => arg !== "--control" && arg !== "--raw-history"))
                throw new Error("Use /pitako agents pane [--control] [--raw-history] or /pitako agents pane close");
              await agentPane.launch({ control: args.includes("--control"), rawHistory: args.includes("--raw-history") });
            }
            return;
          }
          if (ctx.hasUI && ctx.mode === "tui") {
            if (!agentController) throw new Error("Agent controller unavailable for this foreground session");
            await openAgentScreen(ctx, agentController, value);
            return;
          }
          const coordinator = ctx.sessionManager?.getSessionId();
          let rows = coordinator ? listObservations(undefined, coordinator) : [];
          if (value) {
            const one = rows.find((row) => row.id === value);
            if (!one) throw new Error(`unknown worker ${value}`);
            rows = [one];
          }
          const detail = formatAgentsDetail(rows.slice(0, 50), Date.now());
          const bytes = Buffer.from(detail);
          const text = detail.length === 0 ? "no workers" : bytes.subarray(0, 30 * 1024).toString("utf8") +
            (rows.length > 50 || bytes.length > 30 * 1024 ? "\n[clipped; use screen pages]" : "");
          if (ctx.hasUI) notify(ctx, text);
          else console.log(text);
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "stats") {
        try {
          const coordinator = ctx.sessionManager?.getSessionId();
          if (value === "consultations" || value?.startsWith("consultations ")) {
            if (!coordinator || !ownsEvent(ctx)) throw new Error("consultation stats require the authorized foreground caller");
            const parts = args.trim().split(/\s+/);
            if (parts.length > 3) throw new Error("stats consultations accepts one dispatchId");
            notify(ctx, JSON.stringify(await consultationStats(coordinator, parts[2])), "info");
            return;
          }
          const rows = coordinator ? listObservations(teamEvaluation?.token, coordinator) : [];
          if (value) {
            const row = rows.find((item) => item.id === value);
            if (!row) throw new Error(`unknown instance ${value}`);
            const usage = row.agentUsage;
            notify(ctx, [`instance: ${row.id}`, `role: ${row.roleId}`, `status: ${row.status}`, usage ? formatUsage(usage) : "model usage: unknown (attempt has not reported usage)"].filter(Boolean).join("\n"));
            return;
          }
          const sessionId = ctx.sessionManager?.getSessionId?.();
          const lines = [
            `foreground session: ${sessionId ?? "unknown"}`,
            foregroundModelUsage(ctx.sessionManager?.getEntries?.()),
          ];
          if (rows.length) {
            lines.push("AgentInstances:");
            const roles = new Map<string, AgentUsage | undefined>();
            for (const row of rows) {
              if (row.agentUsage) roles.set(row.roleId, mergeUsage(roles.get(row.roleId), row.agentUsage));
              else if (!roles.has(row.roleId)) roles.set(row.roleId, undefined);
            }
            for (const [role, usage] of roles) {
              const incomplete = rows.some((row) => row.roleId === role && !row.agentUsage);
              lines.push(usage ? `role ${role}${incomplete ? " (some instance usage unknown)" : ""}:\n${formatUsage(usage)}` : `role ${role}: usage unknown`);
            }
            for (const row of rows) lines.push(`instance ${row.id} (${row.roleId}, ${row.status}): ${row.agentUsage ? formatUsage(row.agentUsage).replaceAll("\n", " · ") : "usage unknown"}`);
          } else {
            lines.push("AgentInstances: none");
          }
          notify(ctx, lines.join("\n"));
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "profile" && value) {
        setSessionProfile(ctx.sessionManager, parseProfile(value));
        const profile = effectiveProfile(ctx.sessionManager);
        const tools = applyProfile(pi, ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(`Pitako profile: ${profile} (${tools.length} tools)`, "info");
        }
        return;
      }
      const lines = [
        `Pitako profile: ${effectiveProfile(ctx.sessionManager)}`,
        "coding: read, bash, grep, find, ls, LSP, CodeGraph, todo; apply_patch for grammar-capable OpenAI models, otherwise edit/write.",
        "analysis: read, bash, grep, find, ls, LSP, CodeGraph, todo; no edit, write, apply_patch, or lsp_rename",
        "Switch with /pitako profile analysis",
        "Session TODOs: todo tool and /todos (rpiv-todo). Shared knowledge: board_* tools and /board.",
        "Roles: /pitako roles, /pitako role <id>, /pitako policies, /pitako policy <id>. Definitions only.",
        "Background workers: /pitako agents; telemetry: /pitako stats [instance-id]; Team roster: /pitako team",
        "Native histories: /pitako history list [--scope all | --role-id ID | --mission-id ID | --coordinator-session-id ID | --assignment-id ID | --instance-id ID] [--cursor TOKEN] [--limit N]; /pitako history read HISTORY_ID [--cursor TOKEN] [--limit N].",

        ...skillStatusLines(),
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    const targets = event.toolName === "apply_patch"
      ? (event.details as ApplyPatchResult | undefined)?.changes?.filter((change) => change.kind !== "deleted").map((change) => change.moveTo ?? change.path) ?? []
      : event.toolName === "write" || event.toolName === "edit" ? [event.input.path] : [];
    for (const target of targets) {
      if (typeof target !== "string") continue;
      const filename = path.basename(path.resolve(ctx.cwd, target));
      if (!filename.endsWith(".md")) continue;
      const id = filename.slice(0, -3);
      let file: string;
      try {
        file = planFile(id, ctx.cwd);
      } catch {
        continue;
      }
      if (canonicalPath(target, ctx.cwd) !== file) continue;
      const workflow = readWorkflowTitle("plan", id, ctx.cwd);
      if (!workflow) continue;
      const action = sessionNameAction({
        current: pi.getSessionName(),
        existingUserText: firstUserText(ctx.sessionManager?.getEntries?.() ?? []),
        workflow: { ...workflow, fromPlanWrite: true },
      });
      if (action.set !== undefined) pi.setSessionName(action.set);
      if (ctx.hasUI) ctx.ui.setStatus("pitako", pi.getSessionName() || undefined);
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (executionForSession(ctx.sessionManager?.getSessionId())?.profile === "analysis" && isOrchestrationTool(event.toolName))
      return { block: true, reason: "Consultative leaves cannot orchestrate Pitako work" };
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const input = event.input as { path?: unknown };
    const target = typeof input.path === "string" ? input.path : "";
    if (!target || !isProtectedEditPath(target)) return undefined;
    const reason = `Pitako blocked ${event.toolName} to protected path "${target}".`;
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    return { block: true, reason };
  });
}

function latestPlanInvocation(entries: readonly unknown[]): { activity: "plan" | "execute"; id: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const text = userMessageText(message);
    const invocation = planInvocation(text);
    if (invocation) return invocation;
  }
  return undefined;
}

function readWorkflowTitle(activity: "plan" | "execute", id: string, cwd: string): { activity: "plan" | "execute"; title: string } | undefined {
  try {
    const { text } = activity === "execute" ? readFrozenPlan(id, cwd) : readPlan(id, cwd);
    return { activity, title: planHeading(text) ?? id };
  } catch {
    return undefined;
  }
}

function userMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part): part is { type: string; text: string } =>
          !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text).join("")
      : "";
}

function firstUserText(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const text = userMessageText(message);
    if (text.trim()) return text;
  }
  return undefined;
}

function notify(
  ctx: { hasUI: boolean; ui: { notify(message: string, kind?: "info" | "error"): void } },
  message: string,
  kind: "info" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind);
    return;
  }
  if (kind === "error") throw new Error(message);
}

export { PitakoConfigError };
