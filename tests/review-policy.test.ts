import { expect, test } from "bun:test";
import { createReviewPolicy, validateReview } from "../extensions/review/policy.ts";
import type { ReviewBody, TableMessage, Synthesis, Finding } from "../extensions/review/types.ts";
import { mergeKnowledge, type Plan, type Knowledge, type ConsultationResponse, type StageRules } from "../extensions/architecture/protocol.ts";

const finding: Finding = { key: "risk", materiality: "blocking", contract: "Author authority", reference: "source:12",
  consequence: "Erased evidence", basis: { kind: "failure", path: "A calls B without authority", evidence: ["source:12"] } };
const message = (id: string, memberId: string, body: ReviewBody): TableMessage & { body: ReviewBody } => ({
  submission: { version: 2, provenance: "host-bound" }, id, memberId, author: memberId, assignmentId: `assignment-${memberId}`, roomId: "room", snapshotId: "snapshot", ordinal: 1,
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
const submit = (body: ReviewBody) => ({ body });

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
  expect(grant("newcomer", { kind: "preparation" })).toMatchObject({ findings: [], responses: [], references: [] });
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
  const unresolved = grant("director", { kind: "synthesis", pendingDoubts: [{ id: "pending", question: "Observation?", purpose: "Complete work" }], partialReasons: [] });
  expect(() => validateReview(unresolved, submit(synthesis()))).toThrow();
  expect(() => validateReview(unresolved, submit({ ...synthesis(), completion: "partial" }))).not.toThrow();
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

test("exterior grounds resolve only cited reasoning and doubts without copying the journal or private capture", () => {
  const { policy, synthesis } = setup();
  const preparation = message("preparation", "author", { kind: "preparation", analysis: "Independent reasoning",
    findings: [finding], doubts: [{ question: "Which authority?", purpose: "Resolve objection" }] });
  preparation.doubts = [{ id: "doubt", question: "Which authority?", purpose: "Resolve objection" }];
  const support = message("support", "scout", { kind: "consultation-response", doubtIds: ["doubt"],
    answer: "Observed author guard", evidence: ["source:30"], limits: ["One path"], doubts: [] });
  const knowledge = message("knowledge", "director", { kind: "knowledge", resolutions: [
    { doubtId: "doubt", status: "answered", answer: "Guard confirmed", supportIds: ["consultation-response-id"] },
  ] });
  const unused = message("unused", "peer", { kind: "contribution", analysis: "UNREFERENCED-JOURNAL-MARKER",
    findings: [], responses: [], doubts: [] });
  const body = synthesis();
  body.dispositions[0]!.references = ["preparation", "doubt", "support", "knowledge", "doubt", policy.findings[0]!.id];
  body.newFindings = [{ finding: { ...finding, key: "director-dissent" }, status: "unresolved",
    reason: "Independent dissent", references: ["support"] }];
  const final = message("synthesis", "director", body);
  expect(() => validateReview(policy.grant({ roomId: "room", assignmentId: "assignment", memberId: "director", snapshotId: "snapshot", round: 1,
    rules: { kind: "synthesis", pendingDoubts: [], partialReasons: [] } }, [preparation, support, knowledge], []), submit(body))).not.toThrow();
  policy.publish(final);
  const report = policy.report([preparation, support, knowledge, unused, final], [], false);
  expect(report).not.toHaveProperty("messages");
  expect(report.object).not.toHaveProperty("scope");
  expect(report.grounds.map(item => item.reference)).toEqual(["preparation", "doubt", "support", "knowledge"]);
  expect(report.grounds.map(item => item.content)).toEqual([
    { analysis: "Independent reasoning" }, { question: "Which authority?", purpose: "Resolve objection" },
    { doubtIds: ["doubt"], answer: "Observed author guard", evidence: ["source:30"], limits: ["One path"] },
    { resolutions: [{ doubtId: "doubt", status: "answered", answer: "Guard confirmed", supportIds: ["consultation-response-id"] }] },
  ]);
  expect(report.grounds[1]).toMatchObject({ reference: "doubt", messageId: "preparation", author: "author", memberId: "author" });
  expect(report.findings[1]).toMatchObject({ ...finding, key: "director-dissent" });
  expect(report.dispositions![1]).toMatchObject({ findingId: report.findings[1]!.id, status: "unresolved", reason: "Independent dissent", references: ["support"] });
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("UNREFERENCED-JOURNAL-MARKER");
  for (const key of ["native", "turnId", "attemptId", "snapshotId"]) expect(serialized).not.toContain(`"${key}"`);
  expect(report.grounds.every(item => !("body" in item))).toBe(true);
  expect(report.limits).toContain("One path");
  const interrupted = policy.report([preparation, support], ["Cancelled after published observation"], true, preparation.doubts);
  expect(interrupted.pending).toEqual(preparation.doubts);
  expect(interrupted.limits).toContain("One path");
  expect(interrupted.failures).toContain("Cancelled after published observation");
  expect(interrupted.findings).toEqual(report.findings);
  expect(interrupted.verdict).toBe("inconclusive");
});

test.each(["knowledge", "consultation-plan", "consultation-response"] as const)("exterior grounds explain a rejected finding citing only %s", citedKind => {
  const policy = createReviewPolicy({ root: "/controlled", selector: { kind: "brief", text: "Authentication review" },
    identity: "auth-object", scope: "PRIVATE-CAPTURE-MARKER", limits: [] }, "Review bypass", ["Reject expired credentials"]);
  const doubt = { id: "expiry-doubt", question: "Does the alternate authentication path reject expired credentials?",
    purpose: "Decide if the reported bypass is real" };
  const preparation = message("preparation", "author", { kind: "preparation", analysis: "UNREFERENCED-ANALYSIS-MARKER",
    findings: [{ ...finding, contract: "Reject expired credentials", reference: "auth.ts:42", consequence: "Expired credentials accepted",
      basis: { kind: "failure", path: "Alternate authentication path accepts expired credentials", evidence: ["Reported bypass"] } }],
    doubts: [{ question: doubt.question, purpose: doubt.purpose }] });
  preparation.author = "reviewer-author";
  preparation.doubts = [doubt];
  const messages: TableMessage[] = [];
  const grant = (rules: StageRules, memberId = "director") => policy.grant({
    roomId: "room", assignmentId: `assignment-${memberId}`, memberId, snapshotId: "snapshot", round: 1, rules,
  }, messages, []);
  validateReview(grant({ kind: "preparation" }, "author"), submit(preparation.body));
  messages.push(preparation); policy.publish(preparation);

  const delegated = citedKind !== "consultation-plan";
  const planBody: Plan = { kind: "consultation-plan",
    resolutions: delegated ? [] : [{ doubtId: doubt.id, status: "answered", answer: "Yes" }],
    support: delegated ? [{ role: "scout", brief: "Check alternate path expiry", doubtIds: [doubt.id], prerequisites: [] }] : [] };
  const plan = { ...message("plan-message", "director", planBody), body: planBody };
  plan.author = "reviewer-director";
  validateReview(grant({ kind: "consultation-plan", doubts: [doubt] }), submit(plan.body));
  messages.push(plan); policy.publish(plan);
  const responses: ConsultationResponse[] = [];
  let knowledge: (TableMessage & { body: Knowledge }) | undefined;
  if (delegated) {
    const supportBody = { kind: "consultation-response" as const, doubtIds: [doubt.id], answer: "Yes",
      evidence: ["auth.ts:42"], limits: ["Alternate path only"], doubts: [] };
    const support = { ...message("support-message", "scout", supportBody), body: supportBody };
    support.author = "expiry-scout";
    validateReview(grant({ kind: "consultation-response", doubtIds: [doubt.id] }, "scout"), submit(support.body));
    messages.push(support); policy.publish(support);
    responses.push({ id: "consultation-id", assignmentId: support.assignmentId, status: "completed", message: support });
    const knowledgeBody: Knowledge = { kind: "knowledge", resolutions: [
      { doubtId: doubt.id, status: "answered", answer: "Confirmed", supportIds: [responses[0]!.id] },
    ] };
    knowledge = { ...message("knowledge-message", "director", knowledgeBody), body: knowledgeBody };
    knowledge.author = plan.author;
    validateReview(grant({ kind: "knowledge", plan: plan.body, responses }), submit(knowledge.body));
    messages.push(knowledge); policy.publish(knowledge);
  }
  const boundary = mergeKnowledge({ id: "boundary", ordinal: 1, roomId: "room", cycleId: "cycle",
    doubts: [doubt], plan, knowledge, responses });
  const reference = citedKind === "consultation-response" ? responses[0]!.message!.id : knowledge?.id ?? plan.id;
  const body: Synthesis = { kind: "synthesis", completion: "complete", verdict: "no-blockers", summary: "Reported bypass rejected",
    dispositions: [{ findingId: policy.findings[0]!.id, status: "rejected", reason: "Expiry check confirmed", references: [reference] }],
    newFindings: [], evidence: [], limits: [], pending: [] };
  const synthesisGrant = grant({ kind: "synthesis", pendingDoubts: [], partialReasons: [] });
  validateReview(synthesisGrant, submit(body));
  const final = message("synthesis", "director", body);
  policy.publish(final);
  const report = policy.report([...messages, final], [], false, [], [boundary]);
  expect(report).toMatchObject({ completion: "complete", verdict: "no-blockers", missingValidSynthesis: false });
  expect(report.dispositions![0]!.references).toEqual([reference]);
  expect(report.findings[0]).toMatchObject({ objectIdentity: "auth-object", memberId: "author", author: "reviewer-author", messageId: preparation.id });
  expect(report.grounds).toContainEqual({
    reference: doubt.id, messageId: preparation.id, memberId: "author", author: "reviewer-author", stage: "preparation",
    content: { question: doubt.question, purpose: doubt.purpose },
  });
  expect(report.grounds.map(item => item.reference).sort()).toEqual(
    (delegated ? ["knowledge-message", doubt.id, "support-message"] : [reference, doubt.id]).sort());
  expect(report.grounds.find(item => item.reference === (knowledge?.id ?? plan.id))).toMatchObject({
    messageId: knowledge?.id ?? plan.id, memberId: "director", author: "reviewer-director", stage: delegated ? "knowledge" : "consultation-plan",
    content: { resolutions: delegated ? knowledge!.body.resolutions : plan.body.resolutions },
  });
  if (delegated) expect(report.grounds.find(item => item.reference === "support-message")).toMatchObject({
    messageId: "support-message", memberId: "scout", author: "expiry-scout", stage: "consultation-response", consultationId: "consultation-id",
    content: { doubtIds: [doubt.id], answer: "Yes", evidence: ["auth.ts:42"], limits: ["Alternate path only"] },
  });
  const serialized = JSON.stringify(report);
  for (const marker of ["PRIVATE-CAPTURE-MARKER", "UNREFERENCED-ANALYSIS-MARKER", '"messages"', '"native"', '"turnId"', '"attemptId"'])
    expect(serialized).not.toContain(marker);
  body.dispositions[0]!.references.push(reference, reference);
  validateReview(synthesisGrant, submit(body)); policy.publish(message("repeated-synthesis", "director", body));
  expect(policy.report(messages, [], false, [], [boundary]).grounds).toEqual(report.grounds);
});

for (const ownOnly of [false, true]) for (const reversed of [false, true])
test(`exterior grounds retain transitive prerequisite reasoning (reversed=${reversed}, own support only=${ownOnly})`, () => {
  const policy = createReviewPolicy({ root: "/controlled", selector: { kind: "brief", text: "Prerequisite review" },
    identity: "chain-object", scope: "PRIVATE-CAPTURE-MARKER", limits: [] }, "Review prerequisite evidence", ["Preserve reasoning"]);
  const doubts = ["A", "B", "C"].map(id => ({ id, question: `Question ${id}?`, purpose: `Resolve ${id}` }));
  const unrelated = { id: "unrelated-doubt", question: "UNRELATED-QUESTION-MARKER", purpose: "Separate issue" };
  const delegated = [...doubts, unrelated];
  const ordered = [...(reversed ? [...doubts].reverse() : doubts), unrelated];
  const messages: TableMessage[] = [];
  const publish = (authored: TableMessage & { body: ReviewBody }, rules: StageRules) => {
    validateReview(policy.grant({ roomId: "room", assignmentId: authored.assignmentId, memberId: authored.memberId,
      snapshotId: "snapshot", round: authored.round ?? 1, rules }, messages, []), submit(authored.body));
    messages.push(authored); policy.publish(authored);
  };
  const preparation = message("chain-preparation", "author", { kind: "preparation", analysis: "UNREFERENCED-ANALYSIS-MARKER",
    findings: [finding], doubts: ordered.map(({ question, purpose }) => ({ question, purpose })) });
  preparation.author = "reviewer-author"; preparation.round = 2; preparation.doubts = ordered;
  publish(preparation, { kind: "preparation" });
  const planBody: Plan = { kind: "consultation-plan",
    resolutions: [],
    support: delegated.map(({ id }, index) => ({ role: "scout", brief: `Check ${id}`, doubtIds: [id],
      prerequisites: index < 2 ? [index + 1] : [] })) };
  const plan = { ...message("chain-plan", "director", planBody), body: planBody };
  publish(plan, { kind: "consultation-plan", doubts: ordered });
  const responses: ConsultationResponse[] = [];
  // The independent response settles alongside C; the prerequisite chain publishes C, B, A.
  for (const index of [2, 3, 1, 0]) {
    const id = delegated[index]!.id;
    const body = { kind: "consultation-response" as const, doubtIds: [id],
      answer: id === unrelated.id ? "UNRELATED-ANSWER-MARKER" : `Answer ${id}`,
      evidence: [`source:${id}`], limits: [`Path ${id}`], doubts: [] };
    const response = { ...message(`response-${id}`, `scout-${id}`, body), body, author: `reviewer-scout-${id}`, round: 3 };
    publish(response, { kind: "consultation-response", doubtIds: [id] });
    responses[index] = { id: `consult-${id}`, assignmentId: response.assignmentId, status: "completed", message: response };
  }
  const knowledgeBody: Knowledge = { kind: "knowledge", resolutions: [
    { doubtId: "A", status: "answered", answer: "A confirmed with B", supportIds: ownOnly ? ["consult-A"] : ["consult-A", "consult-B"] },
    { doubtId: "B", status: "answered", answer: "B confirmed with C", supportIds: ownOnly ? ["consult-B"] : ["consult-B", "consult-C"] },
    { doubtId: "C", status: "answered", answer: "C confirmed", supportIds: ["consult-C"] },
    { doubtId: unrelated.id, status: "answered", answer: "UNRELATED-RESOLUTION-MARKER", supportIds: [`consult-${unrelated.id}`] },
  ] };
  const knowledge = { ...message("chain-knowledge", "director", knowledgeBody), body: knowledgeBody,
    author: "reviewer-director", round: 4 };
  publish(knowledge, { kind: "knowledge", plan: plan.body, responses });
  const boundary = mergeKnowledge({ id: "chain-boundary", ordinal: 1, roomId: "room", cycleId: "chain-cycle",
    doubts: ordered, plan, knowledge, responses });
  const body: Synthesis = { kind: "synthesis", completion: "complete", verdict: "no-blockers", summary: "Finding refuted by prerequisites",
    dispositions: [{ findingId: policy.findings[0]!.id, status: "rejected", reason: "A is grounded in B and C", references: ["A"] }],
    newFindings: [], evidence: [], limits: [], pending: [] };
  publish(message("chain-synthesis", "director", body), { kind: "synthesis", pendingDoubts: [], partialReasons: [] });
  const report = policy.report(messages, [], false, [], [boundary]);
  expect(report).toMatchObject({ completion: "complete", verdict: "no-blockers", missingValidSynthesis: false });
  expect(report.dispositions![0]!.references).toEqual(["A"]);
  expect(report.findings[0]).toMatchObject({ objectIdentity: "chain-object", memberId: "author", author: "reviewer-author",
    messageId: preparation.id });
  expect(report.grounds.map(item => item.reference).sort()).toEqual(
    ["A", "B", "C", "chain-knowledge", "response-A", "response-B", "response-C"].sort());
  for (const doubt of doubts) {
    expect(report.grounds).toContainEqual({
      reference: doubt.id, messageId: preparation.id, memberId: "author", author: "reviewer-author", stage: "preparation", round: 2,
      content: { question: doubt.question, purpose: doubt.purpose },
    });
    expect(report.grounds).toContainEqual({
      reference: `response-${doubt.id}`, messageId: `response-${doubt.id}`, memberId: `scout-${doubt.id}`,
      author: `reviewer-scout-${doubt.id}`, stage: "consultation-response", round: 3, consultationId: `consult-${doubt.id}`,
      content: { doubtIds: [doubt.id], answer: `Answer ${doubt.id}`, evidence: [`source:${doubt.id}`], limits: [`Path ${doubt.id}`] },
    });
  }
  expect(report.grounds.find(item => item.reference === knowledge.id)).toEqual({
    reference: knowledge.id, messageId: knowledge.id, memberId: "director", author: "reviewer-director", stage: "knowledge", round: 4,
    content: { resolutions: knowledge.body.resolutions.filter(resolution => resolution.doubtId !== unrelated.id) },
  });
  const serialized = JSON.stringify(report);
  for (const marker of ["PRIVATE-CAPTURE-MARKER", "UNREFERENCED-ANALYSIS-MARKER", "UNRELATED-QUESTION-MARKER", "UNRELATED-ANSWER-MARKER", "UNRELATED-RESOLUTION-MARKER",
    '"messages"', '"native"', '"turnId"', '"attemptId"', '"snapshotId"']) expect(serialized).not.toContain(marker);
  body.dispositions[0]!.references.push("A", "response-B", "C", "A");
  publish(message("repeated-chain-synthesis", "director", body), { kind: "synthesis", pendingDoubts: [], partialReasons: [] });
  expect(policy.report(messages, [], false, [], [boundary]).grounds).toHaveLength(report.grounds.length);
  expect(policy.report(messages, [], false, [], [boundary]).grounds).toEqual(expect.arrayContaining(report.grounds));
});

test("exterior grounds project only cited resolutions from an implicit direct plan carrier", () => {
  const policy = createReviewPolicy({ root: "/controlled", selector: { kind: "brief", text: "Carrier review" },
    identity: "carrier-object", scope: "PRIVATE-CAPTURE-MARKER", limits: [] }, "Review carrier", ["Bounded projection"]);
  const doubts = ["A", "D"].map(id => ({ id, question: `Question ${id}?`, purpose: `Resolve ${id}` }));
  const messages: TableMessage[] = [];
  const publish = (authored: TableMessage & { body: ReviewBody }, rules: StageRules) => {
    validateReview(policy.grant({ roomId: "room", assignmentId: authored.assignmentId, memberId: authored.memberId,
      snapshotId: "snapshot", round: authored.round ?? 1, rules }, messages, []), submit(authored.body));
    messages.push(authored); policy.publish(authored);
  };
  const preparation = message("carrier-preparation", "author", { kind: "preparation", analysis: "Independent",
    findings: [finding], doubts: doubts.map(({ question, purpose }) => ({ question, purpose })) });
  preparation.doubts = doubts;
  publish(preparation, { kind: "preparation" });
  const planBody: Plan = { kind: "consultation-plan", resolutions: [
    { doubtId: "A", status: "answered", answer: "A resolved directly" },
    { doubtId: "D", status: "answered", answer: "D resolved independently" },
  ], support: [] };
  const plan = { ...message("carrier-plan", "director", planBody), body: planBody };
  publish(plan, { kind: "consultation-plan", doubts });
  const boundary = mergeKnowledge({ id: "carrier-boundary", ordinal: 1, roomId: "room", cycleId: "carrier-cycle",
    doubts, plan, responses: [] });
  const body: Synthesis = { kind: "synthesis", completion: "complete", verdict: "no-blockers", summary: "Rejected by A alone",
    dispositions: [{ findingId: policy.findings[0]!.id, status: "rejected", reason: "A settles the finding", references: ["A"] }],
    newFindings: [], evidence: [], limits: [], pending: [] };
  publish(message("carrier-synthesis", "director", body), { kind: "synthesis", pendingDoubts: [], partialReasons: [] });
  const report = policy.report(messages, [], false, [], [boundary]);
  expect(report).toMatchObject({ completion: "complete", verdict: "no-blockers" });
  expect(report.grounds.map(item => item.reference).sort()).toEqual(["A", "carrier-plan"].sort());
  expect(report.grounds.find(item => item.reference === "carrier-plan")).toMatchObject({
    content: { resolutions: [{ doubtId: "A", status: "answered", answer: "A resolved directly" }], support: [] },
  });
  expect(JSON.stringify(report)).not.toContain("D resolved independently");
  const explicit: Synthesis = { ...body,
    dispositions: [{ ...body.dispositions[0]!, references: ["A", "carrier-plan"] }] };
  publish(message("carrier-synthesis-explicit", "director", explicit), { kind: "synthesis", pendingDoubts: [], partialReasons: [] });
  const cited = policy.report(messages, [], false, [], [boundary]);
  expect(cited.grounds.find(item => item.reference === "carrier-plan")).toMatchObject({
    content: { resolutions: planBody.resolutions, support: [] },
  });
  expect(JSON.stringify(cited)).toContain("D resolved independently");
});
