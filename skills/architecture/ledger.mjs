import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { receiptLocation } from "../../extensions/access-receipts.mjs";
import { safePath, verifyChain, prepareAppend, publish, readRequest } from "../../extensions/hash-ledger.mjs";
import { canonicalJSON, canonicalDigest } from "../../extensions/canonical.mjs";

const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;

export function ledgerPath(missionPath, consultation) {
  if (typeof consultation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(consultation))
    throw new Error("Invalid architecture consultation ID.");
  const { missionDirectory } = receiptLocation(missionPath, `architecture-${consultation}`, "ledger");
  return safePath(path.join(missionDirectory, "ledger", `architecture-${consultation}`));
}

function validateRecord(record, seq, prev) {
  if (!keys(record, "body,kind,prev,round,seq") || record.seq !== seq || record.prev !== prev ||
      !Number.isSafeInteger(record.round) ||
      (seq === 0 ? record.kind !== "admission" || record.round !== 0 :
        !["decision", "round", "context"].includes(record.kind) || record.round < 0))
    throw new Error("Invalid architecture ledger record or chain link.");
}

/** Verify history against the consultation's retained anchor without creating files. */
export function verifyLedger(missionPath, consultation, expected) {
  return verifyChain(ledgerPath(missionPath, consultation), expected, validateRecord);
}

/** Persist explicit projections, never live native runtime objects. */
export function appendLedger(request) {
  const observe = (keys(request, "consultation,expected,missionPath,observe") || keys(request, "consultation,expected,memo,missionPath,observe")) && request.observe === true;
  if (!observe && (!keys(request, "consultation,expected,missionPath,record") || !keys(request.record, "body,kind,round")))
    throw new Error("Invalid architecture ledger append request.");
  const { missionPath, consultation, expected, record } = request;
  verifyLedger(missionPath, consultation, expected);
  // Measure before publication so an unreadable/unsafe state cannot yield a successful append.
  const { missionDirectory } = receiptLocation(missionPath, `architecture-${consultation}`, "ledger");
  const statePath = safePath(path.join(missionDirectory, "state.json"));
  let stateBytes = 0;
  try {
    const state = statSync(statePath);
    if (!state.isFile()) throw new Error("Mission state is not a regular file.");
    stateBytes = state.size;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (observe) {
    const pendingPath = safePath(path.join(ledgerPath(missionPath, consultation), `${String(expected.count).padStart(6, "0")}.json`));
    let pendingKind;
    if (existsSync(pendingPath)) {
      const bytes = readFileSync(pendingPath, "utf8"), pending = JSON.parse(bytes);
      validateRecord(pending, expected.count, expected.head);
      if (canonicalJSON(pending) !== bytes) throw new Error("Noncanonical pending architecture ledger record.");
      pendingKind = pending.kind;
    }
    if (!request.memo) return { ...expected, stateBytes, ...(pendingKind ? {pendingKind} : {}) };
    if (!keys(request.memo, "digest,path") || !/^[a-f0-9]{64}$/.test(request.memo.digest)) throw new Error("Invalid memo reference.");
    const value = JSON.parse(readFileSync(safePath(request.memo.path), "utf8"));
    if (canonicalDigest(value) !== request.memo.digest || typeof value.memo !== "string") throw new Error("Memo digest/content mismatch.");
    return { ...expected, stateBytes, excerpt: value.memo.slice(0, 240) };
  }
  const entry = { ...record, seq: expected.count, prev: expected.head };
  validateRecord(entry, expected.count, expected.head);
  canonicalJSON(entry);
  const directory = ledgerPath(missionPath, consultation);
  prepareAppend(directory, expected.count);
  return { ...publish(directory, entry), stateBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(appendLedger(readRequest(readFileSync(0, "utf8")))) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: "ledger-integrity", reason: error.message }) + "\n");
    process.stderr.write("Architecture ledger publication failed; inspect the retained request and ledger before retrying.\n");
    process.exitCode = 1;
  }
}
