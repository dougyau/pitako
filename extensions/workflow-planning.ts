import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { assertPlanId, ledgerFile, parsePlanDocument, planFile, planHash, readExecutionBinding, type PlanMeta } from "./workflow.ts";
import { acquireWorkflowOwner, type WorkflowState } from "./workflow-state.ts";
import { captureCallContext, checkCallContext, checkAuthority, observePhaseTurns, planningSlot, reserveEffect, assertPlanningQuiescent, readBoundPlan, guardToolRegistrations, type PhaseAuthority, type AttemptRecord } from "./workflow-engine.ts";
import { consultedPlan } from "./review/object.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "./profile.ts";
import { startReviewTable } from "./review/index.ts";
import { teamEvaluationForSession, selectTeamAssignments } from "./team.ts";
import { selectedTableResult } from "./agent/background.ts";

export type PlanSnapshot = Readonly<{
  file: string; physical: string; revision: number | "absent"; fileHash: string | null;
  objectHash: string | null; text: string | null; meta: PlanMeta | null;
}>;
export type FreezeCandidate = Readonly<{
  candidateId: string; expectedDraft: PlanSnapshot; text: string; consultedText: string;
  fileHash: string; objectHash: string;
  transformations: readonly string[];
}>;
export type PlanWriteReceipt = {
  receiptId: string; file: string; oldHash: string | null; newHash: string;
  snapshot: PlanSnapshot; candidateId?: string;
};
type WriteIntent = {
  kind: "plan-write"; intentId: string; file: string; old: PlanSnapshot; text: string;
  newHash: string; temporary: string; candidateId?: string; receipt?: PlanWriteReceipt;
};
const exact = (a: PlanSnapshot, b: PlanSnapshot) => a.file === b.file && a.physical === b.physical &&
  a.revision === b.revision && a.fileHash === b.fileHash && a.text === b.text;

/** A local slot only. No sibling search, execution binding, or execution ledger. */
export function snapshotPlan(id: string, root: string): PlanSnapshot {
  const file = planFile(assertPlanId(id), root);
  let ancestor = path.dirname(file);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error("planning slot has a symlinked parent");
  if (!existsSync(file)) return Object.freeze({ file, physical: `absent:${realpathSync(root)}:${lstatSync(root).dev}:${lstatSync(root).ino}`,
    revision: "absent", fileHash: null, objectHash: null, text: null, meta: null });
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file) throw new Error("planning slot must be a physical regular file");
  const bytes = readFileSync(file);
  if (!isUtf8(bytes)) throw new Error("planning slot must contain UTF-8");
  const text = bytes.toString("utf8"), meta = parsePlanDocument(text);
  if (meta.id !== id) throw new Error("planning slot id mismatch");
  return Object.freeze({ file, physical: `${realpathSync(file)}:${stat.dev}:${stat.ino}`, revision: meta.revision,
    fileHash: planHash(text), objectHash: planHash(consultedPlan(text)), text, meta: Object.freeze(meta) });
}

function document(id: string, revision: number, status: "draft" | "frozen", body: string,
  execution?: "expected" | "none", topic?: number): string {
  if (/^\s*---(?:\r?\n|$)/.test(body)) throw new Error("writeDraft accepts body content, not model frontmatter");
  return `---\nid: ${id}\nrevision: ${revision}\nstatus: ${status}\n${execution ? `execution: ${execution}\n` : ""}${topic ? `board_topic_id: ${topic}\n` : ""}---\n${body}`;
}
const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");

/** The host owns this port under its live owner lock and reservation. */
export class PlanSlot {
  private current: PlanSnapshot;
  private candidates = new Map<string, FreezeCandidate>();
  constructor(readonly id: string, readonly store: WorkflowState, expected: PlanSnapshot, private check: () => void,
    private checkWrite: () => void = check) {
    this.current = expected;
    this.recover();
    this.read();
  }
  read(): PlanSnapshot {
    this.check();
    const observed = snapshotPlan(this.id, this.store.root);
    if (!exact(this.current, observed)) {
      if (!this.current.meta || observed.text === this.current.text ||
          observed.objectHash !== this.current.objectHash || observed.revision !== this.current.revision)
        throw new Error("planning slot materially changed; new invocation required");
      this.current = observed; // Operational exclusion only; the object identity has not changed.
    }
    return this.current;
  }
  writeDraft(expected: PlanSnapshot, body: string, fields: { execution?: "expected" | "none"; boardTopicId?: number } = {}): PlanWriteReceipt {
    const old = this.read();
    if (!exact(old, expected)) throw new Error("stale planning snapshot");
    if (old.meta && old.meta.status !== "draft") throw new Error("frozen slot requires explicit reopen");
    if (fields.execution !== undefined && !["expected", "none"].includes(fields.execution)) throw new Error("invalid execution intent");
    if (fields.boardTopicId !== undefined && (!Number.isSafeInteger(fields.boardTopicId) || fields.boardTopicId < 1))
      throw new Error("invalid Board topic");
    if (old.meta?.boardTopicId !== undefined && fields.boardTopicId !== undefined && old.meta.boardTopicId !== fields.boardTopicId)
      throw new Error("plan already bound to another Board topic");
    const revision = old.revision === "absent" ? 1 : old.revision;
    const draft = (revision: number) => document(this.id, revision, "draft", body,
      fields.execution ?? old.meta?.execution, fields.boardTopicId ?? old.meta?.boardTopicId);
    const text = draft(revision);
    // Revision identifies material edits, not checkpoints in the declared operational exclusion.
    return this.write(old, old.text !== null && consultedPlan(text) !== consultedPlan(old.text) ? draft(revision + 1) : text);
  }
  metadata(fields: { execution?: "expected" | "none"; boardTopicId?: number }): PlanMeta {
    const old = this.read();
    if (!old.text) throw new Error("plan not found");
    if (old.meta?.execution === fields.execution && fields.boardTopicId === undefined ||
        old.meta?.boardTopicId === fields.boardTopicId && fields.execution === undefined) return old.meta!;
    return this.writeDraft(old, bodyOf(old.text), fields).snapshot.meta!;
  }
  candidate(expected: PlanSnapshot): FreezeCandidate {
    const old = this.read();
    if (!exact(old, expected) || old.meta?.status !== "draft") throw new Error("candidate requires the exact current draft");
    const text = consultedPlan(old.text!).replace(/^(status:)[^\r\n]*$/m, "$1 frozen");
    const consultedText = consultedPlan(text);
    const candidate = Object.freeze({ candidateId: randomUUID(), expectedDraft: old, text, consultedText,
      fileHash: planHash(text), objectHash: planHash(consultedText),
      transformations: Object.freeze(["Remove the operational Planning workers section", "Change host status: draft to status: frozen"]) });
    this.candidates.set(candidate.candidateId, candidate);
    return candidate;
  }
  getCandidate(id: string): FreezeCandidate {
    this.check();
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error("unknown candidate for this planning owner");
    return candidate;
  }
  freeze(candidate: FreezeCandidate): PlanWriteReceipt {
    if (this.getCandidate(candidate.candidateId) !== candidate) throw new Error("foreign FreezeCandidate");
    let old = this.read();
    if (!exact(old, candidate.expectedDraft)) {
      // Only the declared operational exclusion may refresh the file CAS.
      if (old.objectHash !== candidate.expectedDraft.objectHash || old.revision !== candidate.expectedDraft.revision)
        throw new Error("FreezeCandidate is stale");
    }
    return this.write(old, candidate.text, candidate.candidateId);
  }
  reopen(expected: PlanSnapshot): PlanWriteReceipt {
    const old = this.read();
    if (!exact(old, expected) || old.meta?.status !== "frozen") throw new Error("reopen requires the exact frozen snapshot");
    // A local pin cannot be removed by planning. Other registered ledgers are checked by the engine.
    if (existsSync(ledgerFile(this.id, this.store.root))) throw new Error("frozen source is pinned by an execution ledger");
    if (readExecutionBinding(this.id, this.store.root)) throw new Error("frozen source is pinned by an execution binding");
    return this.write(old, document(this.id, old.meta.revision + 1, "draft", bodyOf(old.text!),
      old.meta.execution, old.meta.boardTopicId));
  }
  private write(old: PlanSnapshot, text: string, candidateId?: string): PlanWriteReceipt {
    this.checkWrite();
    if (!exact(snapshotPlan(this.id, this.store.root), old)) throw new Error("planning CAS failed");
    const intentId = randomUUID(), temporary = `${old.file}.${intentId}.tmp`;
    const intent: WriteIntent = { kind: "plan-write", intentId, file: old.file, old, text, newHash: planHash(text), temporary,
      ...(candidateId ? { candidateId } : {}) };
    this.store.transaction(() => this.store.put("dispositions", intentId, intent));
    mkdirSync(path.dirname(old.file), { recursive: true });
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    // Parent creation is host controlled. Existing drafts must still match physical identity and all bytes.
    const observed = snapshotPlan(this.id, this.store.root);
    if (old.revision === "absent" ? observed.revision !== "absent" : !exact(observed, old)) throw new Error("planning CAS failed before rename");
    renameSync(temporary, old.file);
    const directory = openSync(path.dirname(old.file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    const snapshot = snapshotPlan(this.id, this.store.root);
    if (snapshot.text !== text || snapshot.fileHash !== intent.newHash) throw new Error("planning write reobservation mismatch");
    const receipt: PlanWriteReceipt = { receiptId: randomUUID(), file: old.file, oldHash: old.fileHash,
      newHash: intent.newHash, snapshot, ...(candidateId ? { candidateId } : {}) };
    this.store.transaction(() => this.store.put("dispositions", intentId, { ...intent, receipt }));
    if (JSON.stringify(this.store.get<WriteIntent>("dispositions", intentId)?.receipt) !== JSON.stringify(receipt))
      throw new Error("planning receipt was not committed");
    this.current = snapshot;
    return receipt;
  }
  private recover(): void {
    for (const intent of this.store.all<WriteIntent>("dispositions").filter(item => item.kind === "plan-write" &&
      item.file === this.current.file && !item.receipt)) {
      const observed = snapshotPlan(this.id, this.store.root);
      if (observed.text !== intent.text && !exact(observed, intent.old))
        throw new Error("planning recovery blocked by third state; no overwrite");
      if (observed.text === intent.text) {
        const receipt: PlanWriteReceipt = { receiptId: randomUUID(), file: intent.file, oldHash: intent.old.fileHash,
          newHash: intent.newHash, snapshot: observed, ...(intent.candidateId ? { candidateId: intent.candidateId } : {}) };
        this.store.transaction(() => this.store.put("dispositions", intent.intentId, { ...intent, receipt }));
      } else {
        // Exact old state is safe to abandon, never silently overwrite with an old proposal.
        this.store.transaction(() => this.store.put("dispositions", intent.intentId, { ...intent, abandoned: true,
          receipt: { oldStateRetained: true } }));
      }
      if (existsSync(intent.temporary)) unlinkSync(intent.temporary);
      this.current = observed;
    }
  }
}

export type PlanningAcceptance = {
  candidateId: string; reviewAssignmentId: string; designAssignmentId: string; acceptance: string; designAdoption: string;
  absorption: string;
  dispositions: { id: string; decision: "adopted" | "rejected"; reason: string }[];
};
function foregroundPlanning(ctx: ExtensionContext) {
  const context = captureCallContext(ctx.cwd, ctx.sessionManager);
  if (isChildSession(ctx) || context.kind !== "managed") throw new Error("planning requires the live foreground managed invocation");
  const owner = checkAuthority(context.authority);
  if (owner.manager !== ctx.sessionManager || owner.run.phase !== "planning") throw new Error("not the captured planning foreground");
  observePhaseTurns(owner.store, owner.run.runId, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch());
  return { context, owner, slot: planningSlot(context.authority) };
}
function expected(slot: PlanSlot, revision: number | "absent", fileHash: string | null) {
  const snapshot = slot.read();
  if (snapshot.revision !== revision || snapshot.fileHash !== fileHash) throw new Error("stale planning snapshot");
  return snapshot;
}
/** Consume real table output through the host port, never an asserted approval or content supplied by a caller. */
export function acceptPlanning(ctx: ExtensionContext, input: PlanningAcceptance): PlanWriteReceipt {
  const { context, owner, slot } = foregroundPlanning(ctx), candidate = slot.getCandidate(input.candidateId);
  if (owner.run.state !== "active") throw new Error(`planning activity is ${owner.run.state}`);
  const evaluation = teamEvaluationForSession(ctx.sessionManager.getSessionId(), false);
  if (!evaluation) throw new Error("planning judgments require the captured Team evaluation");
  const report = (assignmentId: string) => {
    const assignment = selectTeamAssignments(evaluation, { assignmentId })[0];
    if (!assignment) throw new Error("unknown judgment assignment");
    const selected = selectedTableResult(evaluation.token, assignment.instanceId);
    return { ...selected, value: JSON.parse(selected.canonical) };
  };
  const relation = owner.store.get<{ runId: string; candidateId: string }>("dispositions", `planning-review:${input.reviewAssignmentId}`);
  if (relation?.runId !== owner.run.runId || relation.candidateId !== candidate.candidateId) throw new Error("review does not belong to this FreezeCandidate");
  const review = report(input.reviewAssignmentId), design = report(input.designAssignmentId);
  const r = review.value, d = design.value;
  if (r.protocol !== "review" || r.host?.status !== "completed" || r.host?.closure?.state !== "released" ||
      r.object?.identity !== candidate.objectHash || r.judgment?.completion !== "complete" || r.judgment?.verdict === "inconclusive" ||
      !r.judgment || r.judgment.synthesis?.pending?.length || r.pending?.length || r.failures?.length ||
      r.observations?.final !== candidate.objectHash) throw new Error("review is incomplete, stale or inconclusive");
  if (d.protocol !== "architecture" || d.host?.status !== "completed" || d.host?.closure?.state !== "released" ||
      d.source?.identity !== candidate.expectedDraft.objectHash || d.judgment?.status !== "complete" ||
      d.judgment.pending?.length || d.pending?.length || d.failures?.length) throw new Error("pertinent independent architecture judgment required");
  if (!input.acceptance.trim() || !input.designAdoption.trim() || !input.absorption.trim())
    throw new Error("coordinator acceptance, explicit design adoption and absorption required");
  const ids: string[] = [...(r.findings ?? []).map((finding: { id: string }) => finding.id),
    ...(d.objections ?? []).map((objection: { id: string }) => objection.id)];
  if (new Set(input.dispositions.map(item => item.id)).size !== input.dispositions.length ||
      ids.some(id => !input.dispositions.some(item => item.id === id)) ||
      input.dispositions.some(item => !ids.includes(item.id) || !item.reason.trim()))
    throw new Error("every pertinent finding/objection requires a reasoned coordinator disposition");
  assertPlanningQuiescent(context.authority);
  const obligations = owner.store.all<{ obligationId: string; kind: string; dispatchId?: string; runId: string; cleared: boolean }>("obligations")
    .filter(item => item.runId === owner.run.runId && !item.cleared);
  for (const obligation of obligations) {
    const attempt = obligation.dispatchId ? owner.store.get<AttemptRecord>("attempts", obligation.dispatchId) : undefined;
    if (obligation.kind !== "result" || !attempt?.outcome || !owner.store.closureReceipt(attempt.resource))
      throw new Error("planning obligation remains unabsorbed or unsettled");
  }
  const record = { kind: "planning-acceptance", runId: owner.run.runId, ...input,
    draftHash: candidate.expectedDraft.fileHash, frozenHash: candidate.fileHash, objectHash: candidate.objectHash,
    reviewResultId: review.resultId, designResultId: design.resultId,
    retainedReview: r.judgment, retainedDesign: d.judgment, absorbedObligations: obligations.map(item => item.obligationId) };
  owner.store.transaction(() => owner.store.put("dispositions", `planning-acceptance:${candidate.candidateId}`, record));
  const receipt = slot.freeze(candidate);
  owner.store.transaction(() => {
    owner.store.put("dispositions", `planning-acceptance:${candidate.candidateId}`, { ...record, receipt });
    for (const obligation of obligations) owner.store.put("obligations", obligation.obligationId, { ...obligation, cleared: true });
  });
  return receipt;
}
export function assertPlanningLifecycle(ctx: ExtensionContext, planId: string): void {
  const { owner, slot, context } = foregroundPlanning(ctx), snapshot = slot.read();
  if (slot.id !== planId || snapshot.meta?.status !== "frozen" || snapshot.meta.execution !== "none")
    throw new Error("planning lifecycle requires its accepted frozen execution:none slot; expected remains open");
  assertPlanningQuiescent(context.authority);
  if (owner.store.all<{ runId?: string; cleared?: boolean }>("obligations").some(item => item.runId === owner.run.runId && !item.cleared))
    throw new Error("planning obligations remain");
  const accepted = owner.store.all<{ kind?: string; frozenHash?: string; receipt?: PlanWriteReceipt; absorption?: string }>("dispositions")
    .find(item => item.kind === "planning-acceptance" && item.frozenHash === snapshot.fileHash &&
      item.receipt?.newHash === snapshot.fileHash && item.absorption?.trim());
  if (!accepted) throw new Error("planning acceptance, absorption or committed receipt is missing");
}

export function registerPlanningTools(api: ExtensionAPI, hooks?: {
  afterFreeze(authority: PhaseAuthority, receipt: PlanWriteReceipt): void | Promise<void>;
}): void {
  const pi = guardToolRegistrations(api, "read"), strict = { additionalProperties: false } as const;
  const text = Type.String({ minLength: 1 });
  const cas = { revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("absent")]), fileHash: Type.Union([text, Type.Null()]) };
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
  pi.registerTool({ name: "bound_plan_read", label: "Read bound plan", description: "Read only the host-captured draft snapshot or verified frozen execution source. No path selection; grants no mutation authority.",
    parameters: Type.Object({}, strict), async execute(_id, _params, _signal, _update, ctx) {
      return result(readBoundPlan(captureCallContext(ctx.cwd, ctx.sessionManager)));
    } });
  pi.registerTool({ name: "planning_write", label: "Write planning draft", description: "CAS body proposal in the one captured slot. Frontmatter, revision and status are host owned.",
    parameters: Type.Object({ ...cas, body: Type.String(), execution: Type.Optional(Type.Union([Type.Literal("expected"), Type.Literal("none")])),
      boardTopicId: Type.Optional(Type.Integer({ minimum: 1 })) }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      const { slot } = foregroundPlanning(ctx);
      return result(slot.writeDraft(expected(slot, params.revision, params.fileHash), params.body, params));
    } });
  pi.registerTool({ name: "planning_candidate", label: "Prepare frozen candidate", description: "Precompute exact immutable frozen bytes before final critique.",
    parameters: Type.Object(cas, strict), async execute(_id, params, _signal, _update, ctx) {
      const { slot } = foregroundPlanning(ctx);
      return result(slot.candidate(expected(slot, params.revision, params.fileHash)));
    } });
  pi.registerTool({ name: "planning_review", label: "Review frozen candidate", description: "Start the real independent Reviewer table on the complete registered immutable candidate.",
    parameters: Type.Object({ candidateId: text, goal: text, criteria: Type.Array(text, { minItems: 1 }) }, strict),
    async execute(id, params, _signal, _update, ctx) {
      const { owner, slot } = foregroundPlanning(ctx), candidate = slot.getCandidate(params.candidateId);
      const started = startReviewTable(id, { ...params, object: { kind: "plan", planId: slot.id }, plan: slot.id, unit: "planning" }, ctx,
        { kind: "managed-candidate", candidate });
      if (!("isError" in started) && "assignmentId" in started.details && typeof started.details.assignmentId === "string") {
        const assignmentId = started.details.assignmentId;
        owner.store.transaction(() => owner.store.put("dispositions", `planning-review:${assignmentId}`, {
          kind: "planning-review", runId: owner.run.runId, candidateId: candidate.candidateId }));
      }
      return started;
    } });
  pi.registerTool({ name: "planning_freeze", label: "Accept and freeze planning candidate", description: "Foreground coordinator dispositions/acceptance consume complete pertinent released real tables and write exactly the reviewed bytes. Standalone planning creates no execution ledger; task continues through its captured host derivation.",
    parameters: Type.Object({ candidateId: text, reviewAssignmentId: text, designAssignmentId: text, acceptance: text, designAdoption: text, absorption: text,
      dispositions: Type.Array(Type.Object({ id: text, decision: Type.Union([Type.Literal("adopted"), Type.Literal("rejected")]), reason: text }, strict)) }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      const { context, owner, slot } = foregroundPlanning(ctx);
      if (owner.run.activity === "task" && slot.getCandidate(params.candidateId).expectedDraft.meta?.execution !== "expected")
        throw new Error("task requires an executable frozen candidate");
      const receipt = acceptPlanning(ctx, params);
      await hooks?.afterFreeze(context.authority, receipt);
      return result(receipt);
    } });
}

/** Legacy metadata callers share the same writer; a model-selected id cannot select another managed slot. */
export function updatePlanMetadata(id: string, fields: { execution?: "expected" | "none"; boardTopicId?: number }, root: string): PlanMeta {
  const context = captureCallContext(root);
  if (context.kind === "managed") {
    const slot = planningSlot(context.authority);
    if (slot.id !== id) throw new Error("metadata target is not the bound planning slot");
    return slot.metadata(fields);
  }
  const guard = checkCallContext(context), snapshot = snapshotPlan(id, guard.store.root);
  guard.assertIdle([snapshot.file]);
  const unlock = acquireWorkflowOwner(guard.store.root, id);
  const producer = reserveEffect(context, { reservationId: randomUUID(), kind: "assignment-writer", paths: [snapshot.file] })
    .register("plan-metadata", ["host-operation"]);
  producer.enter();
  try {
    const result = new PlanSlot(id, guard.store, snapshot, () => checkCallContext(context)).metadata(fields);
    producer.observe("host-operation", "closed", true);
    unlock();
    return result;
  } catch (error) {
    // Persisted pending writes or a failed journal do not prove the effect absent.
    producer.observe("host-operation", "unknown");
    throw error;
  }
}
