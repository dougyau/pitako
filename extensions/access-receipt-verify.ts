import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Type } from "typebox";
import { checkReceipt, type ReceiptCheck } from "./access-receipts.mjs";

/**
 * Read-only recomputation of access receipts written by the model-free verifier.
 * It never writes or repairs receipts; unavailable originals and drift are reported.
 */
export default function accessReceiptVerify(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "access_receipt_verify", label: "access_receipt_verify",
    description: "Read-only: recheck file digests and verified cwd-local store records in an access receipt. Supply missionPath, namespace and gate from the designated worktree; receiptPath is for a completed architecture memo. Never writes or quarantines; a receipt attests content identity, not reasoning.",
    parameters: Type.Object({
      receiptPath: Type.Optional(Type.String({ minLength: 1 })),
      missionPath: Type.Optional(Type.String({ minLength: 1 })),
      namespace: Type.Optional(Type.String({ minLength: 1 })),
      gate: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({ status: Type.String() }, { additionalProperties: true }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    async execute(_id, input, _signal, _update, ctx) {
      let report: ReceiptCheck | { status: "invalid-input"; reason: string };
      try {
        if (input.receiptPath !== undefined && [input.missionPath, input.namespace, input.gate].every(value => value === undefined))
          report = checkReceipt({ receiptPath: path.resolve(ctx.cwd, input.receiptPath) }, ctx.cwd);
        else if (input.receiptPath === undefined && input.missionPath && input.namespace && input.gate)
          report = checkReceipt({ missionPath: path.resolve(ctx.cwd, input.missionPath), namespace: input.namespace, gate: input.gate }, ctx.cwd);
        else throw new Error("Supply receiptPath alone, or missionPath, namespace and gate.");
      } catch (error) {
        report = { status: "invalid-input", reason: String(error instanceof Error ? error.message : error) };
      }
      const reason = "code" in report && report.code ? `; ${report.code}` : report.reason ? `; ${report.reason}` : "";
      // Name every original that is not verified-and-unchanged, so the caller
      // sees which one drifted or was blocked without opening details.
      const affected = ("items" in report ? report.items ?? [] : [])
        .filter(item => item.state !== "accessible" || item.current !== "unchanged");
      const lines = affected.slice(0, 10).map(item => `- ${item.id} (${item.store ? `${item.store.scope}#${item.store.seq}` : item.path}): verified ${item.state}, now ${item.current}` +
        (item.expectedDigest && item.currentDigest && item.expectedDigest !== item.currentDigest
          ? `; digest ${item.expectedDigest.slice(0, 12)} -> ${item.currentDigest.slice(0, 12)}` : "") +
        (item.explanation ? `. ${item.explanation}` : ""));
      if (affected.length > lines.length) lines.push(`- ${affected.length - lines.length} more in structured content`);
      return { content: [{ type: "text", text: [`access_receipt_verify: ${report.status}${reason}`, ...lines].join("\n") }],
        structuredContent: JSON.parse(JSON.stringify(report)), details: report, isError: report.status === "invalid-input" };
    },
  });
}
