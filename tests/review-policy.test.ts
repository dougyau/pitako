import { expect, test } from "bun:test";
import { createReviewPolicy, validateReview } from "../extensions/review/policy.ts";
import type { ReviewBody, TableMessage, Synthesis, Finding } from "../extensions/review/types.ts";
import type { StageRules } from "../extensions/architecture/protocol.ts";

const finding: Finding = { key: "risk", materiality: "blocking", contract: "Author authority", reference: "source:12",
  consequence: "Erased evidence", basis: { kind: "failure", path: "A calls B without authority", evidence: ["source:12"] } };
const message = (id: string, memberId: string, body: ReviewBody): TableMessage => ({
  id, memberId, author: memberId, assignmentId: `assignment-${memberId}`, roomId: "room", snapshotId: "snapshot", ordinal: 1,
  stage: body.kind, body, turnId: id, attemptId: id, native: { sessionId: memberId, toolCallId: id, persistence: "unconfirmed" }, doubts: [],
});
function setup() {
  const policy = createReviewPolicy({ root: "/controlled", selector: { kind: "brief", text: "Complete bounded object" },
    identity: "object-identity", scope: "Complete bounded object", limits: [] }, "Review", ["Preserve authority"]);
  const original = message("preparation", "author", { kind: "preparation", analysis: "Independent", findings: [finding], doubts: [] });
  policy.publish(original);
  const grant = (memberId: string, rules: StageRules = { kind: "contribution", objections: [] }, partialReasons: string[] = []) =>
    policy.grant({ roomId: "room", assignmentId: "assignment", memberId, snapshotId: "snapshot", round: 1, rules }, [original], partialReasons);
  const synthesis = (): Synthesis => ({ kind: "synthesis", completion: "complete", verdict: "changes-required", summary: "Material risk",
    dispositions: policy.findings.map(item => ({ findingId: item.id, status: "upheld", reason: "Reachable", references: [item.messageId] })),
    newFindings: [], evidence: [], limits: [], pending: [] });
  return { policy, grant, synthesis };
}
const submit = (body: ReviewBody) => ({ submissionId: "one", body });

test("incoming snapshots, author-only modifications and withdrawal history", () => {
  const { policy, grant } = setup(), incoming = grant("peer"), id = policy.findings[0]!.id;
  const response = { findingId: id, action: "object" as const, reason: "Different evidence", evidence: ["source:20"] };
  const contribution = (responses: any[]): ReviewBody => ({ kind: "contribution", analysis: "Peer judgment", findings: [], responses, doubts: [] });
  expect(() => validateReview(incoming, submit(contribution([response])))).not.toThrow();
  for (const action of ["modify", "withdraw"]) expect(() => validateReview(incoming,
    submit(contribution([{ ...response, action, ...(action === "modify" ? { replacement: finding } : {}) }])))).toThrow();
  policy.publish(message("sibling", "peer", { kind: "preparation", analysis: "Later peer", findings: [{ ...finding, key: "sibling" }], doubts: [] }));
  expect(() => validateReview(incoming, submit(contribution([{ ...response, findingId: policy.findings[1]!.id }])))).toThrow();
  const changed = contribution([{ ...response, action: "modify", replacement: { ...finding, materiality: "nonblocking" } }]);
  expect(() => validateReview(grant("author"), submit(changed))).not.toThrow(); policy.publish(message("modify", "author", changed));
  const withdrawn = contribution([{ ...response, action: "withdraw" }]);
  expect(() => validateReview(grant("author"), submit(withdrawn))).not.toThrow(); policy.publish(message("withdraw", "author", withdrawn));
  expect(policy.findings[0]).toMatchObject({ ...finding, objectIdentity: "object-identity" });
  expect(policy.responses.map(item => item.action)).toEqual(["modify", "withdraw"]);
});

test("exact dispositions, author-supported withdrawals, valid references and acyclic duplicates", () => {
  const { policy, grant, synthesis } = setup(), rules = { kind: "synthesis", pendingDoubts: [], partialReasons: [] } as const;
  const check = (body: Synthesis) => validateReview(grant("director", { ...rules, pendingDoubts: [], partialReasons: [] }), submit(body));
  const valid = synthesis();
  expect(() => check(valid)).not.toThrow();
  for (const body of [
    { ...valid, dispositions: [] },
    { ...valid, dispositions: [...valid.dispositions, ...valid.dispositions] },
    { ...valid, dispositions: [{ ...valid.dispositions[0]!, findingId: "unpublished" }] },
    { ...valid, dispositions: [{ ...valid.dispositions[0]!, status: "withdrawn" as const }] },
    { ...valid, dispositions: [{ ...valid.dispositions[0]!, references: ["unpublished-sibling"] }] },
    { ...valid, dispositions: [{ ...valid.dispositions[0]!, status: "duplicate" as const, duplicateOf: policy.findings[0]!.id }] },
  ]) expect(() => check(body)).toThrow();
  const response = { findingId: policy.findings[0]!.id, action: "withdraw" as const, reason: "Original claim was wrong", evidence: ["source:21"] };
  policy.publish(message("withdrawal", "author", { kind: "contribution", analysis: "Correction", findings: [], responses: [response], doubts: [] }));
  expect(() => check({ ...valid, dispositions: [{ ...valid.dispositions[0]!, status: "withdrawn" }] })).not.toThrow();
  policy.publish(message("second", "author2", { kind: "preparation", analysis: "Independent", findings: [finding], doubts: [] }));
  const two = synthesis();
  two.dispositions.forEach((item, index) => { item.status = "duplicate"; item.duplicateOf = two.dispositions[1 - index]!.findingId; });
  expect(() => check(two)).toThrow();
});

test("work completion, materiality and missing indispensable observation are distinct from verdict", () => {
  const { policy, grant, synthesis } = setup();
  const check = (body: Synthesis, reasons: string[] = []) => validateReview(grant("director", { kind: "synthesis", pendingDoubts: [], partialReasons: reasons }, reasons), submit(body));
  const body = synthesis(); body.verdict = "no-blockers";
  expect(() => check(body)).toThrow();
  body.dispositions[0]!.status = "rejected";
  expect(() => check(body)).not.toThrow();
  expect(() => check(body, ["failed scheduled contribution"])).toThrow();
  expect(() => check({ ...body, completion: "partial" })).toThrow();
  body.verdict = "inconclusive"; expect(() => check({ ...body, completion: "partial" }, ["missing preparation"])).not.toThrow();
  const added = { finding: { ...finding, materiality: "nonblocking" as const, key: "director" }, status: "upheld" as const, reason: "Additional observation", references: [] };
  expect(() => check({ ...body, verdict: "no-blockers", newFindings: [added] })).not.toThrow();
  const missing = { ...added, finding: { ...added.finding, basis: { kind: "missing-observation" as const, observation: "Cancellation result",
    effect: "Cannot judge safe release", nextCapture: "Controlled cancellation with retained disposal", evidence: ["source:30"] } } };
  expect(() => check({ ...body, verdict: "no-blockers", newFindings: [missing] })).toThrow();
  expect(() => check({ ...body, newFindings: [missing] })).not.toThrow();
  const synthesisMessage = message("synthesis", "director", { ...body, newFindings: [missing] });
  policy.publish(synthesisMessage);
  const report = policy.report([synthesisMessage], [], false);
  expect(report.completion).toBe("complete"); expect(report.verdict).toBe("inconclusive");
  expect(report.findings).toHaveLength(2); expect(report.dispositions).toHaveLength(2);
  expect(report.findings[1]!.id).toBe(report.dispositions![1]!.findingId);
  expect(report.findings[0]!.id).not.toBe(report.findings[1]!.id);
});
