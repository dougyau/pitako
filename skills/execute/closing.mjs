import { readFileSync } from "node:fs";
import { canonicalDigest, sha256 } from "../../extensions/canonical.mjs";
import { safePath } from "../../extensions/hash-ledger.mjs";
import { executeStore } from "./ledger.mjs";
import { pitakoReviewerAgent } from "../agent-names.mjs";
// The ledger installs the owned Node TypeScript loader before this source closure.
const { readNativeOriginal, readReviewOriginal } = await import("./loop.ts");
const { verifyComplianceRenewal } = await import("../../extensions/execute-retained.ts");

// Shared with the sandbox root: publication never depends on a root-only result body.
export function closingCompliance(value, original, candidate, cancelledScope = []) {
  if (!["fulfilled", "gaps", "blocked"].includes(value?.status) ||
      typeof value.reason !== "string" || !value.reason.trim() ||
      !Array.isArray(value.requirements) || !value.requirements.length ||
      new Set(value.requirements.map(item => item?.id)).size !== value.requirements.length ||
      value.requirements.some(item => !item || ["id", "source", "reason"].some(key =>
        typeof item[key] !== "string" || !item[key].trim()) ||
        !["fulfilled", "gap", "blocked", "not-applicable"].includes(item.status) ||
        !Array.isArray(item.evidence) || !item.evidence.length || !Array.isArray(item.checks) ||
        ![...item.evidence, ...item.checks].every(text => typeof text === "string" && text.trim())) ||
      value.status === "fulfilled" && (!value.requirements.some(item => item.status === "fulfilled") ||
        value.requirements.some(item => !["fulfilled", "not-applicable"].includes(item.status))))
    throw new Error("Compliance lacks a meaningful source/reason/current-evidence requirements inventory.");
  let reason = "", remaining = 1080;
  for (const point of value.reason.toWellFormed()) {
    const size = encodeURIComponent(JSON.stringify(point)).replace(/%[0-9A-F]{2}|[^%]/g, "x").length - 2;
    if (size > remaining || reason.length + point.length > 360) break;
    reason += point; remaining -= size;
  }
  const result = { ref: { key: original.key, agent: pitakoReviewerAgent(original.key), runId: original.runId,
    results: [{ savedOutputPath: original.path }] }, ok: true, status: value.status, barrier: null,
    reused: false, terminal: null, candidate, original, reason,
    unresolved: value.requirements.filter(item => ["gap", "blocked"].includes(item.status))
      .map(({ id, source, status, reason }) => ({ id, source, status, reason })) };
  const cancelled = cancelledScope.filter(task => !task.completed);
  if (cancelled.length) {
    result.status = "gaps";
    result.reason = cancelled.map(task => `${task.id}: ${task.cancel.reason}`).join("; ");
    result.unresolved.push(...cancelled.map(task => ({ id: task.id, source: "main-session request",
      status: "gap", reason: task.cancel.reason })));
  }
  return result;
}

export function closingArchive(seed, compliance, reportedUsage) {
  const body = JSON.parse(JSON.stringify(seed.body));
  if (compliance) {
    body.compliance = compliance;
    body.analysisCalls ??= [];
    body.analysisCalls.push({ key: compliance.ref.key, stage: "receipt",
      ref: { key: compliance.ref.key, runId: compliance.ref.runId },
      timeoutMs: seed.complianceTimeoutMs, barrier: null });
    const fields = ["input", "output", "cacheRead", "cacheWrite"];
    const tokens = reportedUsage && fields.every(field => Number.isFinite(reportedUsage[field]) &&
      reportedUsage[field] >= 0) ? fields.reduce((sum, field) => sum + reportedUsage[field], 0) : null;
    body.usage.push({ id: `${compliance.ref.runId}:0`, tokens });
  }
  return { kind: "loop", loop: body.number, body };
}

export function resolveClosingPublication(root, request) {
  if (Object.keys(request).sort().join(",") !== "compliance,input,invocation,storeId" ||
      Object.keys(request.input ?? {}).sort().join(",") !== "digest,seq" ||
      request.compliance !== null && Object.keys(request.compliance ?? {}).sort().join(",") !== "key,runId")
    throw new Error("Closing publication integrity: invalid reference request");
  const { store, scope } = executeStore(root, request.invocation);
  const saved = store.readRecords(scope);
  const input = saved.records.find(row => row.seq === request.input.seq && row.digest === request.input.digest);
  const seedRow = saved.records.findLast(row => row.kind === "review-originals" &&
    row.body.archiveSeed?.input.seq === request.input.seq &&
    row.body.archiveSeed.input.digest === request.input.digest &&
    (request.compliance === null || ["", ".g2", ".g3"].some(generation =>
      row.body.archiveSeed.complianceKey.replace(/\.compliance$/, `${generation}.compliance`) === request.compliance.key)));
  if (saved.identity.storeId !== request.storeId || !input || !seedRow)
    throw new Error("Closing publication integrity: missing archive seed");
  let seed = seedRow.body.archiveSeed;
  const admission = saved.records.find(row => row.kind === "root-admission")?.body;
  if (!admission) throw new Error("Closing publication integrity: missing admission");
  try {
    for (const original of seedRow.body.originals) readReviewOriginal(original);
    let compliance, usage;
    if (request.compliance) {
      if (request.compliance.key !== seed.complianceKey) {
        const deadline = verifyComplianceRenewal(root, admission.association, seed.complianceKey, request.compliance);
        seed = { ...seed, complianceTimeoutMs: deadline };
      }
      const verified = readNativeOriginal(root, { association: admission.association }, request.compliance, "pitako.reviewer");
      compliance = closingCompliance(verified.value, { ...request.compliance,
        path: verified.reference.path, digest: canonicalDigest(verified.value) }, seed.body.candidate,
        seed.body.cancelledScope);
      usage = verified.usage;
      if (verified.value.status === "blocked") throw new Error("blocked compliance cannot publish");
    }
    let spec;
    if (seed.expected.count === 0) {
      const { source, digest } = admission.association;
      if (seed.spec?.path !== source || seed.spec?.sha256 !== digest)
        throw new Error("admitted spec reference mismatch");
      const bytes = readFileSync(safePath(source));
      if (sha256(bytes) !== digest) throw new Error("admitted spec SHA-256 mismatch");
      spec = { content: bytes.toString("utf8"), digest };
    }
    return { admission, expected: { invocation: request.invocation, ...seed.expected },
      body: { record: closingArchive(seed, compliance, usage),
        ...(spec ? { spec } : {}) } };
  } catch (error) {
    throw new Error(`Closing original integrity mismatch: ${error.message}`);
  }
}
