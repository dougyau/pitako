import type { MissionUnit } from "./model.ts";

export const TEAM_ROUNDS = ["independent", "critique", "rebuttal", "synthesis"] as const;
export type TeamRound = typeof TEAM_ROUNDS[number];
export type TeamFinding = { id: string; claim: string; evidenceRefs: string[]; detail: Record<string, string>; respondsTo?: { id: string; evidenceRefs: string[] } };
export type TeamBundle = {
  format: "mission-team-bundle-v1";
  unitId: string;
  targetId?: string;
  question?: string;
  childResultHash?: string;
  childResult?: string;
  phase: NonNullable<MissionUnit["team"]>["phase"];
  round: TeamRound;
  memberId: string;
  perspective: string;
  goal: string;
  inputs: string[];
  priorFindings?: TeamFinding[];
};

const detailKeys = {
  planning: ["proposal", "constraints"],
  execution: ["recommendation", "impact"],
  review: ["criterion", "observation"],
} as const;
const categories = ["supported_constraint", "recommendation", "rejected", "uncertainty", "user_choice"];

function row(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`invalid ${label} contract`);
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function pointers(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && value.length === new Set(value).size;
}
function samePointers(a: string[], b: string[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export type ConsultationRequest = {
  format: "mission-consultation-request-v1";
  question: string;
  evidenceRefs: string[];
  members: NonNullable<MissionUnit["team"]>["members"];
  synthesisRole: string;
};

/** Closed terminal alternative to a team response. It grants no dispatch authority. */
export function parseConsultationRequest(bytes: Uint8Array, bundle: TeamBundle, roles: Record<string, unknown>): ConsultationRequest {
  if (bytes.byteLength > 64 * 1024) throw new Error("consultation request exceeds 64 KiB");
  const value = row(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    ["format", "question", "evidenceRefs", "members", "synthesisRole"], "consultation request");
  if (value.format !== "mission-consultation-request-v1" || !text(value.question) || !pointers(value.evidenceRefs) ||
    value.evidenceRefs.length === 0 || !Array.isArray(value.members) || value.members.length < 3 || value.members.length > 5 ||
    !text(value.synthesisRole) || !roles[value.synthesisRole]) throw new Error("invalid consultation request");
  const available = new Set([...bundle.inputs, ...(bundle.priorFindings ?? []).flatMap(({ evidenceRefs }) => evidenceRefs)]);
  if (value.evidenceRefs.some((ref) => !available.has(ref))) throw new Error("consultation evidence pointer is not admitted");
  const members = value.members.map((item) => {
    const member = row(item, ["id", "role", "perspective"], "consultation member");
    if (!text(member.id) || !/^[a-z0-9][a-z0-9_-]*$/.test(member.id) || !text(member.role) ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(member.role) || !roles[member.role] || !text(member.perspective))
      throw new Error("consultation member lacks a frozen role or perspective");
    return member as { id: string; role: string; perspective: string };
  });
  if (new Set(members.map(({ id }) => id)).size !== members.length) throw new Error("duplicate consultation member");
  return { format: "mission-consultation-request-v1", question: value.question, evidenceRefs: value.evidenceRefs,
    members, synthesisRole: value.synthesisRole };
}

/** Outputs are advice, never host acceptance evidence. Validated bytes remain the attempt artifact. */
export function parseTeamResponse(bytes: Uint8Array, bundle: TeamBundle): { findings: TeamFinding[]; classifications?: Array<{ findingId: string; evidenceRefs: string[]; category: string; reason: string }> } {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const common = row(parsed, bundle.round === "synthesis"
    ? ["format", "phase", "round", "memberId", "classifications"]
    : ["format", "phase", "round", "memberId", "findings"], "team response");
  if (common.format !== "mission-team-response-v1" || common.phase !== bundle.phase || common.round !== bundle.round || common.memberId !== bundle.memberId)
    throw new Error("team response phase, round or member does not match immutable bundle");
  const prior = new Map((bundle.priorFindings ?? []).map((finding) => [finding.id, finding]));
  if (bundle.round === "synthesis") {
    if (!Array.isArray(common.classifications)) throw new Error("synthesis must classify findings");
    const seen = new Set<string>();
    const classifications = common.classifications.map((value) => {
      const item = row(value, ["findingId", "evidenceRefs", "category", "reason"], "synthesis classification");
      const finding = prior.get(String(item.findingId));
      if (!finding || seen.has(finding.id) || !pointers(item.evidenceRefs) || !samePointers(item.evidenceRefs, finding.evidenceRefs) ||
        !categories.includes(String(item.category)) || !text(item.reason)) throw new Error("synthesis omitted or misbound a finding");
      seen.add(finding.id);
      return item as { findingId: string; evidenceRefs: string[]; category: string; reason: string };
    });
    if (seen.size !== prior.size) throw new Error("synthesis omitted a required finding");
    return { findings: [], classifications };
  }
  if (!Array.isArray(common.findings)) throw new Error("team findings must be an array");
  const ids = new Set<string>();
  const findings = common.findings.map((value) => {
    const finding = row(value, bundle.round === "independent"
      ? ["id", "claim", "evidenceRefs", "detail"] : ["id", "claim", "evidenceRefs", "detail", "respondsTo"], "team finding");
    if (!text(finding.id) || !/^[a-z0-9][a-z0-9_-]*$/.test(finding.id) || ids.has(finding.id) ||
      !text(finding.claim) || !pointers(finding.evidenceRefs) ||
      bundle.phase === "review" && finding.evidenceRefs.length === 0) throw new Error("invalid finding id, claim or evidence pointers");
    ids.add(finding.id);
    const detail = row(finding.detail, detailKeys[bundle.phase], `${bundle.phase} output`);
    if (Object.values(detail).some((value) => !text(value))) throw new Error("phase output fields must be nonempty");
    let respondsTo: TeamFinding["respondsTo"];
    if (bundle.round !== "independent") {
      const reference = row(finding.respondsTo, ["id", "evidenceRefs"], "peer reference");
      const target = prior.get(String(reference.id));
      if (!target || !pointers(reference.evidenceRefs) || !samePointers(reference.evidenceRefs, target.evidenceRefs) ||
        (bundle.round === "critique" && target.id.startsWith(`independent:${bundle.memberId}:`))) throw new Error("peer finding id or evidence pointers are unbound");
      respondsTo = { id: target.id, evidenceRefs: target.evidenceRefs };
    }
    return { id: `${bundle.round}:${bundle.memberId}:${finding.id}`, claim: finding.claim as string,
      evidenceRefs: finding.evidenceRefs as string[], detail: detail as Record<string, string>, ...(respondsTo ? { respondsTo } : {}) };
  });
  if (findings.length === 0 && (bundle.round === "critique"
    ? [...prior.values()].some(({ id }) => !id.startsWith(`independent:${bundle.memberId}:`))
    : bundle.round === "rebuttal" && [...prior.values()].some(({ id, respondsTo }) =>
      id.startsWith("critique:") && respondsTo?.id.startsWith(`independent:${bundle.memberId}:`))))
    throw new Error("critique or rebuttal omitted peer references");
  return { findings };
}
