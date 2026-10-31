import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;

export function canonicalJSON(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + Array.from(value, item => canonicalJSON(item)).join(",") + "]";
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}";
  }
  throw new Error("Ledger requires JSON values only.");
}

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Walk every component, including the final one; never resolve a symlink.
function safePath(file, createDirectories = false) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Ledger path traverses a symlink.");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Ledger path parent is not a directory.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (createDirectories) {
        try { mkdirSync(current); syncDirectory(path.dirname(current)); }
        catch (creation) { if (creation.code !== "EEXIST") throw creation; }
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe ledger directory.");
      }
    }
  }
  return absolute;
}

export function ledgerPath(root, invocation) {
  if (!path.isAbsolute(root) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation) || invocation.includes(".."))
    throw new Error("Invalid ledger root or invocation.");
  return safePath(path.join(root, ".pi/subagents/execute", invocation));
}
const recordPath = (directory, seq) => safePath(path.join(directory, `${String(seq).padStart(6, "0")}.json`));

function readBytes(file) {
  safePath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Ledger record is not a regular file.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function validateExpected(expected) {
  if (!keys(expected, "count,head") || !Number.isSafeInteger(expected.count) || expected.count < 0 ||
      (expected.count === 0 ? expected.head !== null : !isHash(expected.head))) throw new Error("Invalid ledger anchor.");
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
  validateExpected(expected);
  const directory = ledgerPath(root, invocation), records = [];
  let head = null;
  for (let seq = 0; seq < expected.count; seq++) {
    const bytes = readBytes(recordPath(directory, seq)), record = JSON.parse(bytes);
    validateRecord(record, seq, head);
    if (canonicalJSON(record) !== bytes) throw new Error("Noncanonical ledger record.");
    head = digest(bytes); records.push(record);
  }
  if (head !== expected.head) throw new Error("Ledger head mismatch.");
  return records;
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

function publish(directory, record) {
  const file = recordPath(directory, record.seq), bytes = canonicalJSON(record);
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    safePath(file);
    try { linkSync(temporary, file); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (readBytes(file) !== bytes) throw new Error("Ledger publication conflict.");
    syncDirectory(directory);
  } finally { unlinkSync(temporary); }
  return { count: record.seq + 1, head: digest(bytes) };
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
  safePath(directory, true);
  const next = Math.max(1, expected.count);
  for (const name of readdirSync(directory)) {
    if (/^\d+\.json$/.test(name) && (Number(name.slice(0, -5)) > next || name !== `${String(Number(name.slice(0, -5))).padStart(6, "0")}.json`))
      throw new Error("Ledger has a gap or unexpected record.");
  }
  let anchor = expected;
  if (expected.count === 0) anchor = publish(directory, { prev: null, seq: 0, kind: "spec", loop: 0, body: spec });
  const entry = { prev: anchor.head, seq: anchor.count, kind: record.kind, loop: record.loop, body: record.body };
  validateRecord(entry, anchor.count, anchor.head);
  return publish(directory, entry);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const request = JSON.parse(readFileSync(0, "utf8"));
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
