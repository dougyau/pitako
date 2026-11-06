import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJSON, sha256 as digest } from "../../extensions/canonical.mjs";

import { safePath, validateExpected, verifyChain, prepareAppend, publish, readRequest } from "../../extensions/hash-ledger.mjs";

export { canonicalJSON, readRequest };
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;

export function ledgerPath(root, invocation) {
  if (!path.isAbsolute(root) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation) || invocation.includes(".."))
    throw new Error("Invalid ledger root or invocation.");
  return safePath(path.join(root, ".pi/subagents/execute", invocation));
}
function validateRecord(record, seq, prev) {
  if (!keys(record, "body,kind,loop,prev,seq") || record.seq !== seq || record.prev !== prev ||
      !Number.isSafeInteger(record.loop) || (seq === 0 ? record.loop !== 0 || record.kind !== "spec" : record.loop < 1 || !["unit", "loop"].includes(record.kind)))
    throw new Error("Invalid ledger record or chain link.");
  if (seq === 0 && (!keys(record.body, "content,digest") || typeof record.body.content !== "string" ||
      !isHash(record.body.digest) || digest(record.body.content) !== record.body.digest)) throw new Error("Ledger spec digest mismatch.");
}

/** Read-only verification against the native state's anchor; suffixes may be unpublished-to-state retries. */
export function verifyLedger(root, invocation, expected) {
  return verifyChain(ledgerPath(root, invocation), expected, validateRecord);
}

/** Verified, bounded planning context; never a replacement for exact task originals. */
export function loopSummaries(root, invocation, expected) {
  return summarizeLoops(verifyLedger(root, invocation, expected));
}

/** Publisher projection shared with controlled external-boundary fixtures. */
export function summarizeLoops(records) {
  const bounded = value => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    // Bound encoded bytes too: escaped controls and multibyte text must fit stdout.
    if (Buffer.byteLength(JSON.stringify(text)) <= 512) return text;
    const marker = " [truncated; see verified ledger]";
    let limit = Math.min(text.length, 512);
    while (Buffer.byteLength(JSON.stringify(text.slice(0, limit) + marker)) > 512) limit--;
    return text.slice(0, limit) + marker;
  };
  return records.filter(record => record.kind === "loop").slice(-3).map(record => {
    const body = record.body;
    const fulfilled = body.observation && body.review?.verdict === "clear" && body.compliance?.status === "fulfilled" &&
      body.candidate?.head === body.observation.checkout?.head && body.candidate?.fingerprint === body.observation.checkout?.fingerprint &&
      body.compliance.candidate?.head === body.candidate?.head && body.compliance.candidate?.fingerprint === body.candidate?.fingerprint &&
      body.results?.at(-1)?.checks?.current;
    return { loop: record.loop, status: fulfilled ? "complete" : "gaps",
      gaps: bounded({ work: (body.results ?? []).map(result => ({ taskId: result.taskId,
        remaining: result.remaining, diagnosis: result.diagnosis })), obligations: body.compliance?.unresolved }),
      review: bounded({ verdict: body.review?.verdict, reason: body.review?.reason, unresolved: body.review?.unresolved }),
      compliance: bounded({ status: body.compliance?.status, reason: body.compliance?.reason }),
      rejection: bounded(body.plan?.rejection?.diagnostic ?? "") };
  });
}

/** Bodies are explicit persisted projections owned by the workflow, never live runtime objects. */
export function appendLedger(root, invocation, request) {
  if (!(keys(request, "expected,record,spec") || keys(request, "expected,record")) || !keys(request.record, "body,kind,loop") ||
      !["unit", "loop"].includes(request.record.kind) || !Number.isSafeInteger(request.record.loop) || request.record.loop < 1)
    throw new Error("Invalid ledger append request.");
  const { expected, record } = request;
  validateExpected(expected);
  const records = verifyLedger(root, invocation, expected);
  const spec = request.spec ?? records[0]?.body;
  if (!keys(spec, "content,digest") || typeof spec.content !== "string" || !isHash(spec.digest) || digest(spec.content) !== spec.digest)
    throw new Error("Ledger spec digest mismatch.");
  canonicalJSON(record.body);
  if (records.length && canonicalJSON(records[0].body) !== canonicalJSON(spec)) throw new Error("Ledger spec origin mismatch.");
  const directory = ledgerPath(root, invocation);
  prepareAppend(directory, Math.max(1, expected.count));
  let anchor = expected;
  if (expected.count === 0) anchor = publish(directory, { prev: null, seq: 0, kind: "spec", loop: 0, body: spec });
  const entry = { prev: anchor.head, seq: anchor.count, kind: record.kind, loop: record.loop, body: record.body };
  validateRecord(entry, anchor.count, anchor.head);
  return publish(directory, entry);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const request = readRequest(readFileSync(0, "utf8"));
    if (!(keys(request, "expected,invocation,record,spec") || keys(request, "expected,invocation,record"))) throw new Error("Invalid ledger CLI request.");
    const { invocation, ...append } = request;
    const anchor = appendLedger(process.cwd(), invocation, append);
    process.stdout.write(JSON.stringify({ ...anchor, ...(append.record.kind === "loop"
      ? { summaries: loopSummaries(process.cwd(), invocation, anchor) } : {}) }) + "\n");
  } catch (error) {
    if (error.code === "ENOENT" || /Ledger (?:publication conflict|head mismatch|spec (?:digest|origin) mismatch|has a gap|path traverses)|Invalid ledger record or chain link|Noncanonical ledger record/.test(error.message))
      process.stdout.write(JSON.stringify({ error: "ledger-integrity", reason: error.message }) + "\n");
    process.stderr.write("Execution ledger publication failed; inspect the retained request and ledger before retrying.\n");
    process.exitCode = 1;
  }
}
