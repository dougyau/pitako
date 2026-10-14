import type { AgentSession, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HeadAttachment, LeafScopeAttachment } from "./runtime.ts";
import { marksSideEffect } from "../effects.ts";

const boundedString = Type.String({ minLength: 1, maxLength: 16384 });
const references = Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 32 });
const capacity = Type.Union([
  Type.Object({ route: Type.Literal("direct"), profile: Type.Union([
    Type.Literal("developer_junior"), Type.Literal("developer_mid"), Type.Literal("developer_senior"),
  ]) }, { additionalProperties: false }),
  Type.Object({ route: Type.Literal("default") }, { additionalProperties: false }),
  Type.Object({ route: Type.Literal("classify") }, { additionalProperties: false }),
]);
const node = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }), brief: boundedString,
  deps: Type.Array(Type.String(), { maxItems: 128 }),
  writes: Type.Array(Type.String(), { maxItems: 128 }), capacity,
}, { additionalProperties: false });
const revision = Type.Integer({ minimum: 0 });
const identity = {
  runId: Type.String(), effectiveRevision: revision, historyId: Type.String(), sessionId: Type.String(),
};
const response = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

/** Host-granted local tools. Public orchestration guards remain unchanged. */
export function headExtension(attachment: HeadAttachment, binding: object,
  manager: () => Pick<SessionManager, "getBranch">): ExtensionFactory {
  return pi => {
    pi.registerTool({
      name: "head_result", label: "Head result", description: "Read a physically closed child result belonging to this assignment.",
      parameters: Type.Object({ childId: Type.String() }),
      execute(_id, params) {
        return attachment.own(binding, async () => {
          const result = attachment.dag ? attachment.dag.result(binding, params.childId) : attachment.result(binding, params.childId);
          return { content: [{ type: "text", text: JSON.stringify(result ?? { state: "pending" }) }], details: result };
        });
      },
    });
    pi.registerTool({
      name: "head_wait", label: "Head wait", description: "Wait for closed child results in this assignment.",
      parameters: Type.Object({ after: Type.Optional(revision) }, { additionalProperties: false }),
      execute(_id, _params, signal) {
        return attachment.own(binding, async () => {
          const results = attachment.dag ? await attachment.dag.wait(binding, _params.after ?? 0, signal)
            : await attachment.wait(binding, signal);
          return { content: [{ type: "text", text: JSON.stringify(results) }], details: results };
        });
      },
    });
    const dag = attachment.dag;
    if (dag) {
      dag.bindDiagnostics((kind, data) => pi.appendEntry?.("pitako.head", {
        assignmentId: attachment.assignmentId, headInstanceId: attachment.headInstanceId, kind, data,
      }));
      const localTools = new Set(["head_result", "head_wait", "head_plan", "head_start", "head_observe", "head_input", "head_review", "head_finish"]);
      pi.on("tool_call", event => {
        if (!localTools.has(event.toolName) && marksSideEffect(event.toolName) && !dag.codingAllowed(binding)) {
          return { block: true, reason: "Head coding requires the exclusive integration barrier; reopen before admitting more work" };
        }
      });
      pi.registerTool({
        name: "head_plan", label: "Head plan",
        description: "Read the assignment DAG and post-barrier native verification candidates (entryId, toolCallId, toolName), or edit/cancel/negotiate scoped work. Candidate provenance is not semantic verification. Proposals require head_observe references; steering receipts are not leaf acknowledgment. Supersede work and rewrite dependencies together.",
        parameters: Type.Union([
          Type.Object({ action: Type.Literal("read") }, { additionalProperties: false }),
          Type.Object({ action: Type.Literal("beginIntegration"), expectedRevision: revision }, { additionalProperties: false }),
          Type.Object({ action: Type.Literal("reopen"), epoch: Type.String() }, { additionalProperties: false }),
          Type.Object({ action: Type.Literal("edit"), expectedRevision: revision,
            nodes: Type.Array(node, { maxItems: 128 }), supersede: Type.Array(Type.String(), { maxItems: 128 }) }, { additionalProperties: false }),
          Type.Object({ action: Type.Literal("cancel"), runIds: Type.Array(Type.String(), { minItems: 1, maxItems: 128 }) }, { additionalProperties: false }),
          Type.Object({ action: Type.Literal("propose"), ...identity, expectedRevision: revision,
            next: node, additions: Type.Array(node, { maxItems: 128 }), progress: references }, { additionalProperties: false }),
          Type.Object({ action: Type.Literal("confirm"), ...identity, proposalId: Type.String() }, { additionalProperties: false }),
        ]),
        async execute(_id, params) {
          switch (params.action) {
            case "read": return response({ ...dag.snapshot(binding), verificationCandidates: dag.verificationEntries(binding, manager().getBranch()) });
            case "beginIntegration": return response(dag.beginIntegration(binding, params.expectedRevision, manager().getBranch()));
            case "reopen": return response(dag.reopen(binding, params.epoch));
            case "edit": return response(dag.plan(binding, params));
            case "cancel": return response(dag.cancel(binding, params.runIds));
            case "propose": return response(await dag.propose(binding, params, params.expectedRevision, params.next, params.additions, params.progress));
            case "confirm": return response(dag.confirm(binding, params, params.proposalId));
          }
        },
      });
      pi.registerTool({
        name: "head_start", label: "Head start",
        description: "Explicitly reserve and start a ready batch of Developer leaves. Reservations include preflight through physical closure; conflicting or invalid batches admit nothing. The Head does not write product while leaves write.",
        parameters: Type.Object({ expectedRevision: revision,
          nodeIds: Type.Array(Type.String(), { minItems: 1, maxItems: 128 }) }, { additionalProperties: false }),
        execute(id, params, signal, _update, ctx) {
          return Promise.resolve(response(dag.start(binding, params.expectedRevision, params.nodeIds, id, ctx, pi, signal)));
        },
      });
      pi.registerTool({
        name: "head_finish", label: "Finish integrated Head assignment",
        description: "Return an integrated handoff, not leaf reports. Successful finish requires this epoch and successful native tool-result entry IDs from this Head after its barrier. You judge verification sufficiency after inspecting the relevant diff/tests. Failed finish joins owned children and preserves diagnostics.",
        parameters: Type.Union([
          Type.Object({ status: Type.Literal("completed"), epoch: Type.String(), summary: boundedString,
            verification: references, limits: Type.Array(boundedString, { maxItems: 32 }) }, { additionalProperties: false }),
          Type.Object({ status: Type.Literal("failed"), diagnostic: boundedString,
            evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
            limits: Type.Array(boundedString, { maxItems: 32 }) }, { additionalProperties: false }),
        ]),
        async execute(_id, params) { return response(await dag.finish(binding, params, manager().getBranch())); },
      });
      pi.registerTool({
        name: "head_observe", label: "Head observe",
        description: "Read activity from an owned exact run and native identity, not another assignment or foreground session.",
        parameters: Type.Object({ ...identity, after: Type.Optional(revision), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          briefOffset: Type.Optional(revision) }, { additionalProperties: false }),
        execute(_id, params) { return Promise.resolve(response(dag.observe(binding, params, params))); },
      });
      pi.registerTool({
        name: "head_input", label: "Head input",
        description: "Query or clarify an owned exact native leaf. Does not change contract. Queued/handled/rejected/unconfirmed receipts are not acknowledgment, answers, or actual behavior.",
        parameters: Type.Object({ ...identity, intent: Type.Union([Type.Literal("query"), Type.Literal("steer")]),
          text: boundedString, decisionId: Type.Optional(Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
        async execute(_id, params) { return response(await dag.input(binding, params, params.intent, params.text, params.decisionId)); },
      });
      pi.registerTool({
        name: "head_review", label: "Head review",
        description: "Explicitly judge a physically closed owned result at its effective revision. Satisfy only after inspecting relevant changes and evidence. A known or suspected unmanaged writer must retain closure uncertainty, not reuse writes.",
        parameters: Type.Object({ runId: Type.String(), effectiveRevision: revision,
          judgment: Type.Union([Type.Literal("satisfied"), Type.Literal("rejected")]), evidence: references,
          reason: boundedString, closureConcern: Type.Optional(boundedString) }, { additionalProperties: false }),
        execute(_id, params) {
          return Promise.resolve(response(dag.review(binding, params.runId, params.effectiveRevision, params.judgment,
            params.evidence, params.reason, params.closureConcern)));
        },
      });
    }
    pi.on("agent_before_settle", event => {
      if (attachment.signal.aborted) return;
      return attachment.boundary(binding, event, manager());
    });
  };
}

/** A leaf can acknowledge only its own host-bound proposal; no Head/Team tools are installed. */
export function leafScopeExtension(scope: LeafScopeAttachment,
  session: () => Pick<AgentSession, "sessionId" | "sessionManager">): ExtensionFactory {
  return pi => pi.registerTool({
    name: "head_scope_ack", label: "Leaf scope acknowledgment",
    description: "Read your effective scoped contract, or accept/reject your own exact proposal with observed native progress entry IDs. Receipt is not acknowledgment; acknowledgment is not Head confirmation. Never follow a new contract until current reports its confirmed revision.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("current") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("ack"), proposalId: Type.String(), effectiveRevision: revision,
        accept: Type.Boolean(), progress: references }, { additionalProperties: false }),
    ]),
    execute(_id, params) {
      const native = session();
      return Promise.resolve(response(params.action === "current" ? scope.current(native.sessionId) :
        scope.acknowledge(native.sessionId, params.proposalId, params.effectiveRevision, params.accept,
          params.progress, native.sessionManager.getBranch())));
    },
  });
}
