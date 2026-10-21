import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureCallContext, checkAuthority, checkTaskAuthority, guardToolRegistrations,
  reserveEffect, type PhaseAuthority, type TeamHoldRecord } from "./workflow-engine.ts";
import type { RunRecord, WorkflowState, Reservation, ReleaseReceipt } from "./workflow-state.ts";
import type { PlanWriteReceipt } from "./workflow-planning.ts";
import { isChildSession } from "./profile.ts";
import { foregroundBash } from "./agent/head/managed-tools.ts";
import { hasUnknownClosure } from "./agent/closure.ts";
import { selectedTableResult } from "./agent/background.ts";
import { selectTeamAssignments, teamEvaluationForSession } from "./team.ts";
import { startReviewTable } from "./review/index.ts";
import { captureExecutionObject, executionFingerprint } from "./review/object.ts";

export interface TaskAuthority { readonly intentId: string; readonly epoch: number }
type Acceptance = {
  kind: "execution-acceptance"; acceptanceId: string; runId: string; binding: string; fingerprint: string;
  reviewResultId: string; evidenceRefs: string[]; acceptance: string; absorption: string;
};
type Evidence = {
  kind: "execution-evidence"; evidenceId: string; runId: string; binding: string; fingerprint: string;
  commands: { command: string; exitCode: number; output: string }[]; release: ReleaseReceipt; coverage: string;
};
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

/** Recovery consults committed host records, not status, archive JSON or model text. */
export function taskFreezeReceipt(store: WorkflowState, run: RunRecord): PlanWriteReceipt | undefined {
  if (!run.task) return;
  const records = store.all<{ kind?: string; runId?: string; receipt?: PlanWriteReceipt; candidateId?: string; frozenHash?: string }>("dispositions");
  const accepted = records.filter(item => item.kind === "planning-acceptance" && item.runId === run.runId).at(-1);
  if (!accepted) return;
  const receipt = accepted.receipt ?? records.find(item => item.kind === "plan-write" &&
    item.candidateId === accepted.candidateId && item.receipt?.newHash === accepted.frozenHash)?.receipt;
  if (!receipt || receipt.candidateId !== accepted.candidateId || receipt.newHash !== accepted.frozenHash ||
      receipt.snapshot.meta?.status !== "frozen" || receipt.snapshot.meta.execution !== "expected") return;
  if (run.task.freezeReceiptRef && run.task.freezeReceiptRef !== receipt.receiptId) throw new Error("task FreezeReceipt reference changed");
  return receipt;
}

function execution(ctx: ExtensionContext) {
  const context = captureCallContext(ctx.cwd, ctx.sessionManager);
  if (isChildSession(ctx) || context.kind !== "managed") throw new Error("execution control is foreground only");
  const owner = checkAuthority(context.authority);
  if (owner.manager !== ctx.sessionManager || owner.run.phase !== "execution" || !owner.binding)
    throw new Error("execution requires its captured foreground authority");
  return { context, authority: context.authority, owner };
}
function barriers(authority: PhaseAuthority) {
  const owner = checkAuthority(authority), store = owner.store;
  if (store.all<Reservation>("reservations").some(r => r.runId === owner.run.runId && r.state !== "released" && r.purpose !== "observation"))
    throw new Error("execution resources remain active or unknown");
  if (store.all<TeamHoldRecord>("holds").some(hold => hold.planId === owner.run.planId && !hold.cleared))
    throw new Error("execution holds remain");
  if (store.all<{ runId?: string; cleared?: boolean }>("obligations").some(o => o.runId === owner.run.runId && !o.cleared))
    throw new Error("execution obligations remain unabsorbed");
}
export function finishTask(authority: TaskAuthority, input: {
  expectedVersion: number; freezeReceiptRef: string; executionAcceptanceRef: string;
}) {
  const owner = checkTaskAuthority(authority), store = owner.store, run = store.fence(owner.run);
  if (run.version !== input.expectedVersion || run.phase !== "execution") throw new Error("stale task completion version or phase");
  const freeze = taskFreezeReceipt(store, run);
  const acceptance = store.get<Acceptance>("dispositions", input.executionAcceptanceRef);
  if (!freeze || freeze.receiptId !== input.freezeReceiptRef || run.task?.freezeReceiptRef !== freeze.receiptId ||
      !acceptance || acceptance.kind !== "execution-acceptance" || acceptance.runId !== run.runId ||
      acceptance.binding !== run.binding || run.task.executionAcceptanceRef !== acceptance.acceptanceId ||
      executionFingerprint(store.root) !== acceptance.fingerprint) throw new Error("task requires applicable FreezeReceipt and execution acceptance");
  // A phase authority is deliberately not manufactured from task input.
  if (store.all<Reservation>("reservations").some(r => r.runId === run.runId && r.state !== "released" && r.purpose !== "observation") ||
      store.all<{ runId?: string; cleared?: boolean }>("obligations").some(o => o.runId === run.runId && !o.cleared) ||
      store.all<TeamHoldRecord>("holds").some(h => h.planId === run.planId && !h.cleared))
    throw new Error("task completion barriers remain");
  const receipt = { kind: "task-completion", receiptId: randomUUID(), runId: run.runId, ...input };
  store.transaction(() => {
    checkTaskAuthority(authority);
    const next = { ...run, state: "completed" as const, version: run.version + 1, lastFactAt: new Date().toISOString() };
    store.put("runs", run.runId, next); owner.run = next;
    store.put("dispositions", receipt.receiptId, receipt);
    store.enqueue(`run:${run.runId}`, run.binding, receipt);
  });
  return receipt;
}

/** Real execution ports, shared by standalone /execute and the derived task phase. */
export function registerTaskTools(api: ExtensionAPI, taskFor: (manager: object) => TaskAuthority | undefined,
  finished: (manager: object) => Promise<void>) {
  const pi = guardToolRegistrations(api, "read"), strict = { additionalProperties: false } as const;
  const text = Type.String({ minLength: 1 }), version = Type.Integer({ minimum: 1 });
  pi.registerTool({ name: "execution_gates", label: "Run execution gates",
    description: "Run an explicit finite local selection through the shared foreground process adapter. Captures actual exits/output and exact candidate; not acceptance. No provider, Git or publication prerequisite.",
    parameters: Type.Object({ commands: Type.Array(Type.Object({ command: text, timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 2147483 }) }, strict),
      { minItems: 1, maxItems: 32 }), coverage: text }, strict),
    async execute(_id, params, signal, _update, ctx) {
      const { context, authority, owner } = execution(ctx), before = executionFingerprint(owner.store.root);
      const producer = reserveEffect(context, { reservationId: randomUUID(), kind: "gates", paths: [owner.store.root] })
        .register("execution-gates", ["host-operation"]);
      producer.enter();
      const commands: Evidence["commands"] = [];
      let bytes = 0;
      try {
        for (const item of params.commands) {
          checkAuthority(authority);
          if (signal?.aborted) throw new Error("execution gates aborted");
          let output = "";
          const observed = await foregroundBash.exec(item.command, owner.store.root, {
            timeout: item.timeoutSeconds, signal, env: { ...process.env, BUN_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0" },
            onData(data) { bytes += data.length; if (bytes > 8 * 1024 * 1024) throw new Error("execution gate capture budget exceeded"); output += data.toString(); },
          });
          commands.push({ command: item.command, exitCode: observed.exitCode ?? -1, output });
          if (observed.exitCode !== 0) break;
        }
        const release = producer.observe("host-operation", "closed", true);
        checkAuthority(authority);
        if (!release || commands.length !== params.commands.length || commands.some(c => c.exitCode !== 0) ||
            before !== executionFingerprint(owner.store.root)) throw new Error("execution gates failed, incomplete or candidate changed");
        const evidence: Evidence = { kind: "execution-evidence", evidenceId: randomUUID(), runId: owner.run.runId,
          binding: owner.run.binding, fingerprint: before, commands, release, coverage: params.coverage };
        owner.store.transaction(() => owner.store.put("dispositions", evidence.evidenceId, evidence));
        return result(evidence);
      } catch (error) {
        if (producer.live) producer.observe("host-operation", hasUnknownClosure(error) ? "unknown" : "closed", true);
        owner.store.transaction(() => owner.store.put("dispositions", randomUUID(), { kind: "execution-gates-diagnostic",
          runId: owner.run.runId, commands, error: String(error) }));
        throw error;
      }
    } });
  pi.registerTool({ name: "execution_review", label: "Review complete execution",
    description: "Start the existing independent Reviewer table on this captured root and frozen plan, including Git-free projects. Final acceptance requires its selected released complete exterior.",
    parameters: Type.Object({ goal: text, criteria: Type.Array(text, { minItems: 1 }) }, strict),
    async execute(id, params, _signal, _update, ctx) {
      const { owner } = execution(ctx), object = captureExecutionObject(owner.binding!);
      const started = startReviewTable(id, { ...params, object: object.selector, plan: owner.run.planId, unit: "final-review" }, ctx,
        { kind: "managed-execution", binding: owner.binding! });
      if (!("isError" in started) && "assignmentId" in started.details && typeof started.details.assignmentId === "string") {
        const assignmentId = started.details.assignmentId;
        owner.store.transaction(() => owner.store.put("dispositions", `execution-review:${assignmentId}`, {
          kind: "execution-review", runId: owner.run.runId, fingerprint: object.identity, binding: owner.run.binding }));
      }
      return started;
    } });
  pi.registerTool({ name: "execution_acceptance", label: "Accept execution",
    description: "Coordinator interpretation of real gates and the complete released independent Review. Records findings/dispositions and absorption; status/counts never substitute. Does not finish a task.",
    parameters: Type.Object({ expectedVersion: version, reviewAssignmentId: text, evidenceRefs: Type.Array(text, { minItems: 1 }),
      acceptance: text, absorption: text, dispositions: Type.Array(Type.Object({ id: text, reason: text,
        decision: Type.Union([Type.Literal("adopted"), Type.Literal("rejected")]) }, strict)) }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      const { owner, authority } = execution(ctx), store = owner.store, run = store.fence(authority.fence);
      if (params.expectedVersion !== run.version) throw new Error("stale execution acceptance version");
      const fingerprint = executionFingerprint(store.root);
      const relation = store.get<{ runId: string; fingerprint: string; binding: string }>("dispositions", `execution-review:${params.reviewAssignmentId}`);
      if (!relation || relation.runId !== run.runId || relation.fingerprint !== fingerprint || relation.binding !== run.binding)
        throw new Error("execution Review is foreign or stale");
      const evaluation = teamEvaluationForSession(ctx.sessionManager.getSessionId(), false);
      const assignment = evaluation && selectTeamAssignments(evaluation, { assignmentId: params.reviewAssignmentId })[0];
      if (!assignment || !evaluation) throw new Error("execution Review assignment unavailable");
      const selected = selectedTableResult(evaluation.token, assignment.instanceId), review = JSON.parse(selected.canonical);
      if (review.protocol !== "review" || review.host?.status !== "completed" || review.host?.closure?.state !== "released" ||
          !review.judgment || review.judgment.completion !== "complete" || review.judgment.verdict === "inconclusive" ||
          review.judgment.synthesis?.pending?.length || review.pending?.length || review.failures?.length ||
          review.object?.identity !== fingerprint || review.observations?.final !== fingerprint)
        throw new Error("execution Review is incomplete, inconclusive or stale");
      const findings: { id: string }[] = review.findings ?? [];
      if (new Set(params.dispositions.map(d => d.id)).size !== params.dispositions.length ||
          findings.some(f => !params.dispositions.some(d => d.id === f.id)) ||
          params.dispositions.some(d => !findings.some(f => f.id === d.id) || !d.reason.trim()) ||
          !params.acceptance.trim() || !params.absorption.trim()) throw new Error("complete dispositions, acceptance and absorption required");
      for (const ref of params.evidenceRefs) {
        const evidence = store.get<Evidence>("dispositions", ref);
        if (!evidence || evidence.kind !== "execution-evidence" || evidence.runId !== run.runId ||
            evidence.binding !== run.binding || evidence.fingerprint !== fingerprint || !store.verifyReceipt(evidence.release))
          throw new Error("execution evidence is missing, foreign or stale");
      }
      // Absorb only actual released successful result producers. Failed work still needs D's explicit recovery.
      const obligations = store.all<{ obligationId: string; kind: string; dispatchId?: string; runId?: string; cleared?: boolean }>("obligations")
        .filter(o => o.runId === run.runId && !o.cleared);
      for (const obligation of obligations) {
        const attempt = obligation.dispatchId && store.get<{ outcome?: { status: string }; reservationId: string;
          archive?: boolean; watch?: unknown; roleId: string }>("attempts", obligation.dispatchId);
        const internalCancellation = attempt && attempt.archive === false && !attempt.watch &&
          ["architect", "reviewer"].includes(attempt.roleId) && attempt.outcome?.status === "cancelled";
        if (obligation.kind !== "result" || !attempt || !(attempt.outcome?.status === "completed" || internalCancellation) ||
            store.get<Reservation>("reservations", attempt.reservationId)?.state !== "released")
          throw new Error("execution obligation needs disposition or exact recovery");
      }
      const acceptance: Acceptance = { kind: "execution-acceptance", acceptanceId: randomUUID(), runId: run.runId,
        binding: run.binding, fingerprint, reviewResultId: selected.resultId, evidenceRefs: params.evidenceRefs,
        acceptance: params.acceptance, absorption: params.absorption };
      store.transaction(() => {
        checkAuthority(authority);
        for (const obligation of obligations) store.put("obligations", obligation.obligationId, { ...obligation, cleared: true });
        barriers(authority);
        store.put("dispositions", acceptance.acceptanceId, { ...acceptance, retainedReview: review, dispositions: params.dispositions });
        const next = { ...run, version: run.version + 1, lastFactAt: new Date().toISOString(),
          ...(run.task ? { task: { ...run.task, executionAcceptanceRef: acceptance.acceptanceId } } : {}) };
        store.put("runs", run.runId, next); owner.run = next;
        store.enqueue(`run:${run.runId}`, run.binding, { kind: "execution-accepted", acceptanceId: acceptance.acceptanceId });
      });
      return result(acceptance);
    } });
  pi.registerTool({ name: "task_status", label: "Inspect task receipts",
    description: "Read the current foreground task version and committed phase references. Reading does not schedule, renew or finish.",
    parameters: Type.Object({}, strict), async execute(_id, _params, _signal, _update, ctx) {
      if (isChildSession(ctx)) throw new Error("task control is foreground only");
      const task = taskFor(ctx.sessionManager);
      if (!task) throw new Error("no live task");
      const owner = checkTaskAuthority(task);
      return result(owner.store.fence(owner.run));
    } });
  pi.registerTool({ name: "task_finish", label: "Finish accepted task",
    description: "Terminal task transition only with live task intent, exact version, FreezeReceipt, execution acceptance and released work barriers. Never publishes.",
    parameters: Type.Object({ expectedVersion: version, freezeReceiptRef: text, executionAcceptanceRef: text }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      if (isChildSession(ctx)) throw new Error("task control is foreground only");
      const task = taskFor(ctx.sessionManager);
      if (!task) throw new Error("no live task");
      const receipt = finishTask(task, params);
      await finished(ctx.sessionManager);
      return result(receipt);
    } });
}
