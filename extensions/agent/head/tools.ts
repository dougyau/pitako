import type { AgentSession, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HeadAttachment, LeafScopeAttachment } from "./runtime.ts";
import { marksSideEffect } from "../effects.ts";
import { feedbackSchema } from "../consultation-feedback.ts";
import { reasoningSchema } from "../consultation.ts";
import { listCheckpoints, readCheckpoint } from "../checkpoints.ts";
import { guardToolRegistrations } from "../../workflow-engine.ts";

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
    pi = guardToolRegistrations(pi, "read");
    let captured: ReturnType<typeof manager> | undefined, sessionId: string | undefined, sessionFile: string | undefined;
    attachment.bindNative(binding, () => {
      const current = manager();
      const native = current as Partial<Pick<SessionManager, "getSessionId" | "getSessionFile">>;
      if (!captured) { captured = current; sessionId = native.getSessionId?.(); sessionFile = native.getSessionFile?.(); }
      return current === captured && native.getSessionId?.() === sessionId && native.getSessionFile?.() === sessionFile;
    });
    pi.on("turn_start", () => attachment.observeTurn(binding, manager()));
    pi.on("context", () => attachment.observeReceipts(binding, manager()));
    pi.on("message_end", event => {
      if (event.message.role === "assistant" && (event.message.stopReason === "aborted" || event.message.stopReason === "error"))
        attachment.restrictRecovery(binding, event.message.stopReason);
    });
    pi.on("agent_settled", () => attachment.settleDeliveries(binding, manager()));
    const rawWaitArguments = new Map<string, unknown[]>();
    pi.on("tool_call", event => {
      if (event.toolName !== "head_wait") return;
      const occurrences = rawWaitArguments.get(event.toolCallId) ?? [];
      occurrences.push(structuredClone(event.input));
      rawWaitArguments.set(event.toolCallId, occurrences);
    });
    pi.registerTool({
      name: "head_result", label: "Head result", description: "Read a physically closed child result belonging to this assignment.",
      parameters: Type.Object({ childId: Type.String() }),
      execute(_id, params) {
        return attachment.own(binding, async () => {
          attachment.observeReceipts(binding, manager());
          const result = attachment.consultationResult(binding, params.childId) ?? (attachment.dag ? attachment.dag.result(binding, params.childId) : attachment.result(binding, params.childId));
          return { content: [{ type: "text", text: JSON.stringify(result ?? { state: "pending" }) }], details: result };
        });
      },
    });
    pi.registerTool({
      name: "head_wait", label: "Head wait", description: "Wait for independent owned progress. A direct real return may carry owned gates; after normal append, head_plan(read) or completed verification:[] exposes authentic proof IDs. No rerun or intermediate final is needed. Nested/Codemode returns without a transcript head_wait pair are not native gates proof.",
      parameters: Type.Object({ after: Type.Optional(revision) }, { additionalProperties: false }),
      execute(_id, _params, signal) {
        attachment.check(binding);
        const raw = rawWaitArguments.get(_id);
        const wait = attachment.gates?.beginWait(binding, _id, raw?.length === 1 ? raw[0] : undefined, _params.after ?? 0);
        return attachment.withGateWait(async () => {
          const results = attachment.dag ? await attachment.dag.wait(binding, _params.after ?? 0, signal)
            : await attachment.wait(binding, signal);
          const emitted = wait && !attachment.dag?.finishStatus ? attachment.gates!.emitWait(wait) : undefined;
          if (!emitted?.gates.length) return response(results);
          const details = { ...results, gates: emitted.gates };
          return { content: [{ type: "text" as const, text: JSON.stringify(results) },
            ...emitted.blocks.map(text => ({ type: "text" as const, text }))], details };
        });
      },
    });
    if (attachment.gates) pi.registerTool({
      name: "head_gates", label: "Owned verification gates", exposure: "model-only",
      description: "Request finite host-owned serial checks for the current candidate; status/cancel/read are diagnostic, never finish evidence. Read root GATES.md and select relevant commands; manual obligations remain explicit. No setup, product writes, installs or external effects are granted.",
      parameters: Type.Union([
        Type.Object({ action: Type.Literal("request"), epoch: Type.String(), expectedRevision: revision, coverage: boundedString,
          commands: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), shell: boundedString,
            cwd: Type.String({ maxLength: 4096 }), env: Type.Record(Type.String(), Type.String()), timeoutMs: Type.Number({ exclusiveMinimum: 0, maximum: 2147483647 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
        Type.Object({ action: Type.Literal("status"), runId: Type.String() }, { additionalProperties: false }),
        Type.Object({ action: Type.Literal("cancel"), runId: Type.String() }, { additionalProperties: false }),
        Type.Object({ action: Type.Literal("read"), runId: Type.String(), artifact: Type.String(), offset: Type.Optional(revision), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })) }, { additionalProperties: false }),
      ]),
      execute(_id, params) {
        const gates = attachment.gates!;
        switch (params.action) {
          case "request": return Promise.resolve(response(gates.request(binding, params)));
          case "status": return Promise.resolve(response(gates.status(binding, params.runId)));
          case "cancel": return Promise.resolve(response(gates.cancel(binding, params.runId)));
          case "read": return Promise.resolve(response(gates.read(binding, params.runId, params.artifact, params.offset, params.limit)));
        }
      },
    });
    const dag = attachment.dag;
    if (dag) {
      dag.bindDiagnostics((kind, data) => pi.appendEntry?.("pitako.head", {
        assignmentId: attachment.assignmentId, headInstanceId: attachment.headInstanceId, kind, data,
      }));
      const localTools = new Set(["head_gates", "consultation_feedback", "head_consult", "head_result", "head_wait", "head_plan", "head_start", "head_observe", "head_input", "head_review", "head_finish"]);
      if (attachment.managed) {
        localTools.add("head_checkpoint");
        pi.registerTool({
          name: "head_checkpoint", label: "Local Head checkpoint",
          description: "Developer Head: create a local Git checkpoint or list/read this assignment's checkpoints. Available from admission; creation requires supported Git and physically released writers/operations; pending nodes are allowed. Creation leases out writes and graph/integration changes. Use the current revision and literal relative file paths; any rejection refuses the whole write. Committed/refused/uncertain results do not satisfy nodes, final verification, acceptance or publication. Inspect uncertain identity before any retry.",
          parameters: Type.Union([
            Type.Object({ action: Type.Literal("create"), expectedRevision: revision,
              paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 256 }),
              summary: boundedString, remaining: Type.Array(boundedString, { maxItems: 32 }),
              limits: Type.Array(boundedString, { maxItems: 32 }),
              evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }) }, { additionalProperties: false }),
            Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
            Type.Object({ action: Type.Literal("read"), checkpointId: Type.String(), commit: Type.String() }, { additionalProperties: false }),
          ]),
          async execute(_id, params, signal) {
            attachment.check(binding);
            attachment.observeReceipts(binding, manager());
            if (params.action === "create") return response(await attachment.checkpoints(binding,
              result => pi.appendEntry?.("pitako.head.checkpoint", result)).create(params, signal));
            const root = attachment.managed!.root;
            return response(params.action === "list" ? listCheckpoints(root, attachment.assignmentId) :
              readCheckpoint(root, { assignmentId: attachment.assignmentId, checkpointId: params.checkpointId, commit: params.commit }));
          },
        });
      }
      pi.registerTool({
        name: "consultation_feedback", label: "Consultation feedback",
        description: "Voluntary attributed assessment after an exact pitako.head.result receipt in the current Head branch. Optional links resolve only this Head's catalog children. Not review, verification or acceptance.",
        parameters: feedbackSchema,
        execute(_id, params) { return Promise.resolve(response(attachment.feedback(binding, params, manager()))); },
      });
      pi.registerTool({
        name: "head_consult", label: "Head consultation",
        description: "Reserve a shared Head slot and return an early consultation handle. Advice never satisfies a node or verification. Optional default/direct/classify reasoning.",
        parameters: Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("researcher"), Type.Literal("oracle")]),
          task: boundedString, reasoning: reasoningSchema }, { additionalProperties: false }),
        execute(id, params, signal, _update, ctx) {
          attachment.observeReceipts(binding, manager());
          return Promise.resolve(response(attachment.consult(binding, params, id, ctx, pi, signal)));
        },
      });
      pi.on("tool_call", event => {
        attachment.observeReceipts(binding, manager());
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
          attachment.observeReceipts(binding, manager());
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
          attachment.observeReceipts(binding, manager());
          return Promise.resolve(response(dag.start(binding, params.expectedRevision, params.nodeIds, id, ctx, pi, signal)));
        },
      });
      pi.registerTool({
        name: "head_finish", label: "Finish integrated Head assignment",
        description: "Return an integrated handoff, not leaf reports. Completed attempts return finished, needs-proof-selection, pending or unavailable. verification:[] never selects/succeeds; inspect authentic current native-tool/owned-gates entry IDs and select explicitly. Pending return/append is not failure; do not rerun gates or wait on yourself. Judge sufficiency after diff/tests. Logical completion is not physical closure. Failed finish revokes and joins owned work.",
        parameters: Type.Union([
          Type.Object({ status: Type.Literal("completed"), epoch: Type.String(), summary: boundedString,
            verification: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
            limits: Type.Array(boundedString, { maxItems: 32 }) }, { additionalProperties: false }),
          Type.Object({ status: Type.Literal("failed"), diagnostic: boundedString,
            evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
            limits: Type.Array(boundedString, { maxItems: 32 }) }, { additionalProperties: false }),
        ]),
        async execute(_id, params) { attachment.observeReceipts(binding, manager()); return response(await dag.finish(binding, params, manager().getBranch())); },
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
  return pi => guardToolRegistrations(pi, "read").registerTool({
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
