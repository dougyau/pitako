import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { validateSubmission as architectureSubmission, SubmissionError, type StageGrant, type StageRules } from "../architecture/protocol.ts";
import { captureObject, type ReviewObject } from "./object.ts";
import { submitSchema, type ReviewBody, type TableMessage, type PublishedFinding, type Response, type Synthesis } from "./types.ts";

export interface ReviewGrant extends Omit<StageGrant, "rules"> {
  rules: StageRules;
  findings: PublishedFinding[];
  responses: AuthoredResponse[];
  references: string[];
  partialReasons: string[];
}
export interface AuthoredResponse extends Response { memberId: string; messageId: string }

export function validateReview(grant: ReviewGrant, value: unknown): { submissionId: string; body: ReviewBody } {
  const reject = (field: string, badIds: string[] = [], missingIds: string[] = []): never => {
    throw new SubmissionError({ code: "reference", stage: grant.rules.kind, field, badIds, missingIds, correctionsLeft: 0 });
  };
  if (!Value.Check(submitSchema, value)) reject("body");
  const submitted = value as { submissionId: string; body: ReviewBody }, body = submitted.body;
  if (body.kind !== grant.rules.kind) reject("body.kind");
  const meaningful = (value: unknown): boolean => typeof value === "string" ? !!value.trim()
    : Array.isArray(value) ? value.every(meaningful)
    : !value || typeof value !== "object" || Object.values(value).every(meaningful);
  if (!meaningful(body)) reject("body");
  const references = (ids: string[]) => { for (const id of ids) if (!grant.references.includes(id)) reject("references", [id]); };
  if (body.kind === "preparation" || body.kind === "contribution") {
    const keys = new Set<string>();
    for (const finding of body.findings) {
      if (keys.has(finding.key)) reject("findings.key", [finding.key]);
      keys.add(finding.key);
    }
    if (body.kind === "contribution") {
      const seen = new Set<string>();
      for (const response of body.responses) {
        const finding = grant.findings.find(item => item.id === response.findingId);
        if (!finding || seen.has(response.findingId)) reject("responses.findingId", [response.findingId]);
        seen.add(response.findingId);
        if (["modify", "withdraw"].includes(response.action) && finding!.memberId !== grant.memberId) reject("responses.author", [response.findingId]);
        if ((response.action === "modify") !== !!response.replacement) reject("responses.replacement");
        if (response.replacement && response.replacement.key !== finding!.key) reject("responses.replacement.key");
      }
    }
  } else if (body.kind === "synthesis") {
    const ids = new Set<string>();
    for (const disposition of body.dispositions) {
      if (ids.has(disposition.findingId) || !grant.findings.some(item => item.id === disposition.findingId)) reject("dispositions.findingId", [disposition.findingId]);
      ids.add(disposition.findingId); references(disposition.references);
      if (disposition.status === "withdrawn") {
        const finding = grant.findings.find(item => item.id === disposition.findingId)!;
        const last = grant.responses.filter(item => item.findingId === finding.id && item.memberId === finding.memberId &&
          ["modify", "withdraw"].includes(item.action)).at(-1);
        if (last?.action !== "withdraw") reject("dispositions.withdrawn", [finding.id]);
      }
      if ((disposition.status === "duplicate") !== !!disposition.duplicateOf) reject("dispositions.duplicateOf");
      if (disposition.duplicateOf && !grant.findings.some(item => item.id === disposition.duplicateOf)) reject("dispositions.duplicateOf", [disposition.duplicateOf]);
    }
    const missing = grant.findings.filter(item => !ids.has(item.id)).map(item => item.id);
    if (missing.length) reject("dispositions", [], missing);
    for (const disposition of body.dispositions) {
      const seen = new Set<string>([disposition.findingId]); let next = disposition.duplicateOf;
      while (next) {
        if (seen.has(next)) reject("dispositions.duplicateCycle", [next]);
        seen.add(next); next = body.dispositions.find(item => item.findingId === next)?.duplicateOf;
      }
    }
    const keys = new Set<string>();
    for (const added of body.newFindings) {
      if (keys.has(added.finding.key)) reject("newFindings.key", [added.finding.key]);
      keys.add(added.finding.key); references(added.references);
    }
    if (body.completion === "complete" && (grant.partialReasons.length ||
      grant.rules.kind === "synthesis" && grant.rules.pendingDoubts.length))
      reject("completion", ["complete"], [...grant.partialReasons,
        ...(grant.rules.kind === "synthesis" ? grant.rules.pendingDoubts.map(doubt => doubt.id) : [])]);
    const effective = (finding: PublishedFinding) => grant.responses.filter(item => item.findingId === finding.id && item.memberId === finding.memberId &&
      item.action === "modify").at(-1)?.replacement ?? finding;
    const material = (finding: { materiality: string; basis: { kind: string } }) => finding.materiality === "blocking" || finding.basis.kind === "missing-observation";
    if (body.verdict === "no-blockers" && (body.completion !== "complete" || grant.partialReasons.length || body.pending.length ||
      (grant.rules.kind === "synthesis" && grant.rules.pendingDoubts.length) ||
      body.dispositions.some(item => ["upheld", "unresolved"].includes(item.status) && material(effective(grant.findings.find(finding => finding.id === item.findingId)!))) ||
      body.newFindings.some(item => material(item.finding)))) reject("verdict", ["no-blockers"]);
  } else {
    architectureSubmission(grant, value);
  }
  return submitted;
}

export function createReviewPolicy(object: ReviewObject, goal: string, criteria: string[]) {
  const findings: PublishedFinding[] = [], responses: AuthoredResponse[] = [], failures: string[] = [];
  let synthesis: Synthesis | undefined, dispositions: Synthesis["dispositions"] | undefined;
  let observed: ReviewObject | undefined, observationError: string | undefined;
  const id = (message: TableMessage, key: string) => createHash("sha256").update(JSON.stringify([object.identity, message.memberId, message.id, key])).digest("hex");
  const publish = (message: TableMessage) => {
    const body = message.body;
    if ("findings" in body) for (const finding of body.findings) findings.push({ ...structuredClone(finding), id: id(message, finding.key),
      objectIdentity: object.identity, author: message.author, memberId: message.memberId, messageId: message.id });
    if ("responses" in body) for (const response of body.responses) responses.push({ ...structuredClone(response), memberId: message.memberId, messageId: message.id });
    if (body.kind === "synthesis" && "completion" in body) {
      const added = body.newFindings.map(item => ({ ...structuredClone(item.finding), id: id(message, item.finding.key),
        objectIdentity: object.identity, author: message.author, memberId: message.memberId, messageId: message.id }));
      const judged = body.newFindings.map((item, index) => ({ findingId: added[index]!.id, status: item.status, reason: item.reason, references: item.references }));
      // No authored provisional reaches this boundary. IDs and judgments commit together.
      findings.push(...added); dispositions = [...structuredClone(body.dispositions), ...structuredClone(judged)]; synthesis = structuredClone(body);
    }
  };
  return {
    object, goal, criteria, findings, responses, failures, publish,
    grant(grant: StageGrant, messages: TableMessage[], partialReasons: string[]): ReviewGrant {
      return { ...grant, findings: grant.rules.kind === "preparation" ? [] : structuredClone(findings),
        responses: grant.rules.kind === "preparation" ? [] : structuredClone(responses),
        references: grant.rules.kind === "preparation" ? [] :
          [...messages.map(item => item.id), ...findings.map(item => item.id), ...messages.flatMap(item => item.doubts.map(doubt => doubt.id))],
        partialReasons };
    },
    reobserve() {
      try { observed = captureObject(object.selector, object.root); if (observed.identity !== object.identity) failures.push("Review object drift"); }
      catch (error) { observationError = String(error); failures.push(`Review object reobservation failed: ${error}`); }
    },
    report(messages: TableMessage[], reasons: string[], cancelled: boolean) {
      const completion = cancelled ? "failed" : !synthesis ? "failed" : reasons.length || failures.length ? "partial" : synthesis.completion;
      return { protocol: "review", goal, object, criteria, findings: structuredClone(findings), responses: structuredClone(responses),
        synthesis: synthesis ?? null, dispositions: dispositions ?? null,
        missingValidSynthesis: !synthesis, completion,
        verdict: completion !== "complete" ? "inconclusive" : synthesis?.verdict ?? "inconclusive",
        failures: [...reasons, ...failures], messages: structuredClone(messages),
        observations: { launch: object.identity, final: observed?.identity ?? null, error: observationError ?? null },
        limits: [...object.limits, "Structural validation does not prove reasoning truth, exhaustive review, or future model obedience. Bash is trusted, not sandboxed."] };
    },
  };
}
export type ReviewPolicy = ReturnType<typeof createReviewPolicy>;
