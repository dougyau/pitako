import { Type } from "typebox";
import { groupIds } from "./history-query.ts";
import type { ConsultationLocator, HistoryMember, WorkerHistory } from "./history.ts";

export const feedbackSchema = Type.Object({
  dispatchId: Type.String({ minLength: 1, maxLength: 128 }),
  usefulness: Type.Union([Type.Literal("used"), Type.Literal("partial"), Type.Literal("not_used"), Type.Literal("unknown")]),
  note: Type.Optional(Type.String({ maxLength: 4096 })),
  followupInstances: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 })),
}, { additionalProperties: false });
export interface ConsultationFeedbackInput {
  dispatchId: string; usefulness: "used" | "partial" | "not_used" | "unknown";
  note?: string; followupInstances?: readonly string[];
}

/** Only catalog-owned instances may contribute consumption; association never establishes cause. */
export function feedbackLinks(store: WorkerHistory, locator: ConsultationLocator, input: ConsultationFeedbackInput,
  permits: (member: HistoryMember) => boolean) {
  if (input.dispatchId !== locator.dispatchId || !["used", "partial", "not_used", "unknown"].includes(input.usefulness) ||
      input.note !== undefined && (typeof input.note !== "string" || Buffer.byteLength(input.note) > 4096)) throw new Error("invalid consultation feedback");
  const links = input.followupInstances ?? [];
  if (!Array.isArray(links) || links.length > 32 || new Set(links).size !== links.length ||
      links.some(id => typeof id !== "string" || !id || id.length > 256 || id === locator.instanceId || id === locator.callerHeadInstanceId))
    throw new Error("invalid, self or duplicate followup link");
  if (!links.length) return [];
  const owned = new Set<string>(), claimed = new Set<string>();
  // Scan the complete catalog, retaining only requested matches. Ownership is not a page-size limit.
  for (const groupId of groupIds(store.catalogDir)) {
    const group = store.read(groupId);
    for (const member of group.members)
      if (member.instanceId && links.includes(member.instanceId) && permits(member)) owned.add(member.instanceId);
    for (const row of group.consultations ?? []) if (row.dispatchId !== locator.dispatchId)
      for (const id of links) if (row.followupInstances?.includes(id)) claimed.add(id);
  }
  for (const id of links) {
    if (!owned.has(id)) throw new Error("followup is not an owned catalog instance");
    if (claimed.has(id)) throw new Error("followup already linked to another consultation");
  }
  return [...links];
}
