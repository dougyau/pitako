// Deterministic access receipts: the workflow-dispatched verifier compares each
// published original with the value the workflow admitted, and the read-only
// tool/CLI recompute current digests later. No model creates or copies receipts.
import "../skills/execute/loader.mjs";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalDigest, canonicalJSON, jsonDifferences, sha256 } from "./canonical.mjs";
import { safeSegment, validateMissionPath } from "./hash-ledger.mjs";
import { memoReceiptHistory } from "../skills/architecture/ledger.mjs";

const { PitakoStore, StoreError } = await import("./pitako-store.ts");

/** Verifier stdin bound (the workflow checks it before dispatch); exceeding it fails, never truncates. */
export const VERIFIER_STDIN_LIMIT = 1024 * 1024;
/** Verifier stdout bound, below the native external-cli capture ceiling. */
export const VERIFIER_STDOUT_LIMIT = 60 * 1024;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const storeItem = item => record(item.store) && Object.keys(item.store).sort().join(",") === "scope,seq,storeId" &&
  typeof item.store.storeId === "string" && !!item.store.storeId &&
  typeof item.store.scope === "string" && /^(exec|review|arch|todo|access):.+$/.test(item.store.scope) &&
  Number.isSafeInteger(item.store.seq) && item.store.seq > 0 && validDigest(item.digest) &&
  !Object.hasOwn(item, "path") && !Object.hasOwn(item, "admitted");

/** HUMAN #4224: only a completed architecture memo keeps its receipt file. */
export function receiptLocation(missionPath, namespace, gate) {
  validateMissionPath(missionPath);
  if (!safeSegment(namespace) || !safeSegment(gate)) throw new Error("Invalid access receipt namespace or gate.");
  const missionDirectory = path.join(path.dirname(missionPath), path.basename(missionPath, ".json"));
  return { missionDirectory, receiptPath: path.join(missionDirectory, "receipts", namespace, `${gate}.json`) };
}

// Only execute re-verifies a blocked gate under a new .rN gate on relaunch.
// Standalone review refuses retained state and architecture reuses the same
// gate, so for them a restored original cannot resume the same pass.
export const resumableNamespace = namespace => typeof namespace === "string" && namespace.startsWith("execute-");
const NEW_PASS = "continue with a new invocation or consultation";
export function accessAction(cause, resumable) {
  const restore = what => resumable ? `${what} and resume execute, or ${NEW_PASS}.` : `This pass cannot resume: ${NEW_PASS}.`;
  switch (cause) {
    case "missing-record":
    case "store-corrupt": return "The deterministic store writer rechecks the failure and quarantines if confirmed.";
    case "store-busy": return "Retry through the workflow store recovery path.";
    case "store-unavailable":
    case "store-replaced":
    case "superseded": return "The workflow store is unavailable for this receipt.";
    case "wrong-cwd": return "Use the designated worktree for this receipt.";
    case "missing-file": return `${restore("Restore the published original from its native run artifacts")} Do not recreate it by hand.`;
    case "parse-error": return `${restore("Restore the published original from its native run artifacts")} Do not repair it by hand.`;
    case "content-differs": return `Decide which version is authoritative. ${restore("Return the published file to the admitted value")} The workflow does not choose a version.`;
    case "output-save-error": return `Native publication failed, so no original can be verified. ${NEW_PASS[0].toUpperCase()}${NEW_PASS.slice(1)}; inspect the native run for the save error.`;
    case "retained-incompatible": return `The retained state belongs to an incompatible Pitako contract. ${NEW_PASS[0].toUpperCase()}${NEW_PASS.slice(1)}.`;
    case "verifier-failed": return `Verification did not run; the original was not judged unavailable. Inspect the pitako.originals-verifier run and resolve its failure, then ${resumable ? "resume" : NEW_PASS}.`;
    default: return NEW_PASS;
  }
}

/** One explanation format for every cause, workflow- or verifier-detected. */
export function explainAccess({ state, cause, id, key, path: file, store, pointers = [], expectedDigest, digest }, resumable = false) {
  const location = store ? `store ${store.scope}#${store.seq}` : `path ${file ?? "none"}`;
  return `Original ${id} (key ${key ?? "unknown"}, ${location}) is ${state}: ${cause}.` +
    (expectedDigest ? ` Expected digest: ${expectedDigest}; actual digest: ${digest}.` : "") +
    (pointers.length ? ` Differing JSON pointers: ${pointers.join(", ")}.` : "") + ` Action: ${accessAction(cause, resumable)}`;
}

function storeFailure(item, cwd = process.cwd()) {
  try { new PitakoStore(cwd).verifyRecord(item.store, item.digest.toLowerCase()); }
  catch (error) {
    if (error instanceof StoreError) return error.code;
    throw error;
  }
  return null;
}

function verifyItem(item) {
  let bytes;
  try { bytes = readFileSync(item.path, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR" && error?.code !== "EISDIR") throw error;
    return { id: item.id, key: item.key, path: item.path, digest: null, state: "unavailable", cause: "missing-file", pointers: [] };
  }
  let published;
  try { published = JSON.parse(bytes); } catch {
    return { id: item.id, key: item.key, path: item.path, digest: null, state: "unavailable", cause: "parse-error", pointers: [] };
  }
  const digest = canonicalDigest(published);
  const digestMode = Object.hasOwn(item, "digest");
  const pointers = digestMode ? [] : jsonDifferences(published, item.admitted, 10);
  const differs = digestMode ? digest !== item.digest.toLowerCase() : pointers.length > 0;
  return { id: item.id, key: item.key, path: item.path, digest,
    ...(digestMode && differs ? { expectedDigest: item.digest.toLowerCase() } : {}),
    state: differs ? "contradictory" : "accessible", cause: differs ? "content-differs" : null, pointers };
}

function validateRequest(request) {
  if (!record(request) || Object.keys(request).sort().join(",") !== "gate,items,missionPath,namespace" ||
      !Array.isArray(request.items) || !request.items.length || request.items.some(item => !record(item) ||
        Object.keys(item).some(field => !["id", "key", "path", "admitted", "digest", "store"].includes(field)) ||
        typeof item.id !== "string" || !item.id || typeof item.key !== "string" || !item.key ||
        (Object.hasOwn(item, "store") ? !storeItem(item)
          : typeof item.path !== "string" || !path.isAbsolute(item.path) || item.path.includes("\0") ||
            (Object.hasOwn(item, "admitted") === Object.hasOwn(item, "digest")) ||
            (Object.hasOwn(item, "digest") && !validDigest(item.digest)))) ||
      new Set(request.items.map(item => item.id)).size !== request.items.length)
    throw new Error("Invalid access verifier request: expected {missionPath, namespace, gate, items:[{id, key, path, admitted|digest} or {id, key, store:{storeId, scope, seq}, digest}]}.");
  for (const item of request.items) if (Object.hasOwn(item, "admitted")) canonicalJSON(item.admitted);
}

function publish(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, file); return "published"; }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    return readFileSync(file, "utf8") === bytes ? "identical" : "conflict";
  } finally { unlinkSync(temporary); }
}

function correspondingMemo(consultation, request, receipt, retained, cwd) {
  if (receipt.items.some(item => item.state !== "accessible")) return false;
  try {
    const prior = JSON.parse(retained.toString("utf8"));
    if (!Array.isArray(prior?.items) || prior.items.length !== receipt.items.length) return false;
    const stored = prior.items.filter(item => item?.store);
    if (!stored.length || stored.some(item => !storeItem(item) || item.store.scope !== `arch:${consultation}`)) return false;
    const pin = stored.reduce((a, b) => a.store.seq >= b.store.seq ? a : b);
    const items = memoReceiptHistory(cwd, request.missionPath, consultation, request.gate, pin, receipt.items);
    return retained.equals(Buffer.from(canonicalJSON({ ...receipt, items }) + "\n"));
  } catch { return false; }
}

const memoNamespace = (namespace, gate) => /^v[1-9]\d*-memo-/.test(gate)
  ? /^architecture-([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(namespace)?.[1] : undefined;
export const accessReceiptKey = (missionPath, gate) => canonicalDigest([missionPath, gate]);
const receiptBytes = receipt => canonicalJSON(receipt) + "\n";
function storedReceipt(row, storeId) {
  const { scope, seq, body: value } = row;
  return { value, receipt: { store: { storeId, scope, seq }, digest: sha256(receiptBytes(value)) } };
}

/** Read the immutable receipt for one mission's gate, without rechecking the originals. */
export function readAccessReceipt({ missionPath, namespace, gate }, cwd = process.cwd(), recheck) {
  const { receiptPath } = receiptLocation(missionPath, namespace, gate);
  if (memoNamespace(namespace, gate)) {
    if (!existsSync(receiptPath)) return null;
    const bytes = readFileSync(receiptPath, "utf8");
    const value = JSON.parse(bytes);
    if (receiptBytes(value) !== bytes) throw new Error("Noncanonical access receipt.");
    return { value, receipt: { path: receiptPath, digest: sha256(bytes) } };
  }
  const store = new PitakoStore(cwd, undefined, recheck && { root: cwd, storeId: recheck.reference.store.storeId });
  const scope = `access:${namespace}`;
  const lookup = (records, identity) => {
    const row = records.find(row => row.opKey === accessReceiptKey(missionPath, gate));
    if (!row) return null;
    if (row.kind !== "receipt" || row.body?.namespace !== namespace || row.body?.gate !== gate)
      throw new StoreError("store-corrupt", "Access receipt identity mismatch.");
    return storedReceipt(row, identity.storeId);
  };
  if (recheck) return store.verifyReviewAccessForWrite(scope, recheck.authorize, (records, identity) => {
    const found = lookup(records, identity);
    if (!found || canonicalDigest(found.receipt) !== canonicalDigest(recheck.reference))
      throw new StoreError("store-corrupt", "Access receipt differs from the native settlement.");
    return found;
  });
  if (!existsSync(store.file)) return null;
  const { identity, records } = store.readRecords(scope);
  return lookup(records, identity);
}

function inspectGate(request, cwd) {
  const standaloneReview = /^review-[a-f0-9]{64}$/.test(request?.namespace);
  validateRequest(request);
  // One archived round can supply several items with the same pinned row.
  const observedRows = new Map();
  const items = request.items.map(item => {
    if (!item.store) return verifyItem(item);
    const key = canonicalJSON([item.store, item.digest]);
    if (!observedRows.has(key)) observedRows.set(key, storeFailure(item, cwd));
    const cause = observedRows.get(key);
    return { id: item.id, key: item.key, store: item.store, digest: item.digest.toLowerCase(),
      state: cause ? "unavailable" : "accessible", cause, pointers: [] };
  }).map(({ expectedDigest, ...item }) => ({ ...item,
    explanation: item.state === "accessible" ? "Published original equals the admitted value."
      : standaloneReview
        ? `Original ${item.id} (key ${item.key}, path ${item.path}) is ${item.state}: ${item.cause}. Expected digest: ${expectedDigest}; actual digest: ${item.digest}. Dependent review was not dispatched.`
        : explainAccess({ ...item, expectedDigest }, resumableNamespace(request.namespace)) }));
  const observations = items.map(({ id, state, cause, digest, store, explanation }) => ({
    id, state, cause, digest: store && cause ? null : digest, ...(store && cause ? { code: cause } : {}),
    ...(state === "accessible" ? {} : { explanation }) }));
  const receipt = { v: 1, namespace: request.namespace, gate: request.gate,
    items: items.map(({ pointers, ...item }) => ({ ...item, pointers })) };
  return {receipt, observations};
}

/** Recompute path-only receipt bytes for standalone review's store-loss proof. */
export function provePathReceipt(request, digest, cwd) {
  if (request.items.some(item => item.store)) throw new Error("Path receipt proof requires path-only originals.");
  const { receipt } = inspectGate(request, cwd);
  if (sha256(receiptBytes(receipt)) !== digest)
    throw new Error("Reconstructed access receipt differs from the native settlement.");
  return receipt;
}

/** Verify one consuming gate and publish its no-clobber receipt. */
export function verifyGate(request, cwd = process.cwd()) {
  const { receiptPath } = receiptLocation(request.missionPath, request.namespace, request.gate);
  const { receipt, observations } = inspectGate(request, cwd);
  if (observations.some(item => item.code))
    // No verified gate was reached. Leave the no-clobber identity available
    // for relaunch after the calling deterministic writer rechecks.
    return { v: 1, outcome: "unavailable", receipt: null, items: observations };
  const bytes = receiptBytes(receipt), digest = sha256(bytes);
  const memoConsultation = memoNamespace(request.namespace, request.gate);
  let outcome, reference;
  if (memoConsultation) {
    outcome = publish(receiptPath, bytes);
    const retained = readFileSync(receiptPath);
    if (outcome === "conflict" && correspondingMemo(memoConsultation, request, receipt, retained, cwd))
      outcome = "corresponding";
    reference = { path: receiptPath, digest: sha256(retained) };
  } else {
    const store = new PitakoStore(cwd, () => null), scope = `access:${request.namespace}`;
    const saved = store.commit(scope, undefined, accessReceiptKey(request.missionPath, request.gate), digest,
      () => ({ kind: "receipt", body: receipt }));
    if (saved.outcome === "appended" || saved.outcome === "replay") {
      outcome = saved.outcome === "appended" ? "published" : "identical";
      reference = { store: { storeId: saved.identity.storeId, scope, seq: saved.head.seq }, digest };
    } else if (saved.outcome === "replay-differs") {
      outcome = "conflict";
      const retained = readAccessReceipt(request, cwd);
      if (!retained || retained.receipt.store.storeId !== saved.identity.storeId)
        throw new StoreError("store-replaced", "Store changed during access receipt publication.");
      reference = retained.receipt;
    } else throw new Error(`Access receipt ${saved.outcome}.`);
  }
  return { v: 1, outcome, receipt: reference,
    ...(outcome === "conflict" ? { explanation: memoConsultation ? "Architecture ledger integrity failure: memo receipt correspondence failed."
      : `Access receipt already exists with different content for gate ${request.gate}. A changed published original was re-verified under the same gate. ${/^review-[a-f0-9]{64}$/.test(request.namespace) ? "Dependent review was not dispatched."
        : resumableNamespace(request.namespace) ? "Restore the original to its verified bytes and resume." : "This pass cannot resume under that gate."}` } : {}),
    items: observations };
}

/** Read-only recomputation of current digests against a receipt; reports drift and pruning. */
export function checkReceipt(input, cwd = process.cwd()) {
  let found;
  try {
    if (typeof input?.receiptPath === "string") {
      const file = path.resolve(input.receiptPath);
      if (existsSync(file)) {
        const bytes = readFileSync(file, "utf8"), value = JSON.parse(bytes);
        if (receiptBytes(value) !== bytes) throw new Error("Noncanonical access receipt.");
        found = { value, receipt: { path: file, digest: sha256(bytes) } };
      }
    } else found = readAccessReceipt(input, cwd);
  } catch (error) {
    if (error instanceof StoreError) return { status: "unavailable", code: error.code, receipt: null, reason: error.message };
    if (!(error instanceof SyntaxError) && error.message !== "Noncanonical access receipt.") throw error;
    return { status: "invalid", receipt: null, reason: "receipt is not a canonical v1 access receipt" };
  }
  if (!found) return { status: "missing", receipt: null, reason: "receipt not found for this gate" };
  const { value: receipt, receipt: reference } = found;
  if (!record(receipt) || receipt.v !== 1 || !Array.isArray(receipt.items) ||
      receipt.items.some(item => !record(item) || Object.hasOwn(item, "store") && !storeItem(item)))
    return { status: "invalid", receipt: reference, reason: "receipt is not a canonical v1 access receipt" };
  const items = receipt.items.map(item => {
    if (item.store) {
      const { id, store, state } = item;
      const code = storeFailure(item, cwd);
      if (code) return { id, store, state: "unavailable", current: "not-verified", code, expectedDigest: item.digest,
        explanation: explainAccess({ ...item, state: "unavailable", cause: code }) };
      return state === "accessible" ? { id, store, state, current: "unchanged" }
        : { id, store, state, current: "not-verified", explanation: item.explanation };
    }
    if (item.state !== "accessible") return { id: item.id, path: item.path, state: item.state, current: "not-verified", explanation: item.explanation };
    let current;
    try { current = canonicalDigest(JSON.parse(readFileSync(item.path, "utf8"))); }
    catch (error) { return { id: item.id, path: item.path, state: item.state, current: error?.code === "ENOENT" ? "missing" : "unparsable" }; }
    return { id: item.id, path: item.path, state: item.state, current: current === item.digest ? "unchanged" : "drift",
      ...(current === item.digest ? {} : { expectedDigest: item.digest, currentDigest: current }) };
  });
  const code = items.find(item => item.code)?.code;
  const status = code ? "unavailable" : items.some(item => item.state !== "accessible") ? "blocked"
    : items.every(item => item.current === "unchanged") ? "verified" : "drift";
  return { status, ...(code ? { code } : {}), receipt: { ...reference, namespace: receipt.namespace, gate: receipt.gate }, items };
}

// pi-subagents external-cli stdin is "<System instructions>\n...\n\n<Task>\n<task>".
function readRequest(input) {
  const marker = "\n<Task>\n", at = input.indexOf(marker);
  return JSON.parse(at === -1 ? input : input.slice(at + marker.length));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "--verify-stdin") {
      const input = readFileSync(0, "utf8");
      if (Buffer.byteLength(input, "utf8") > VERIFIER_STDIN_LIMIT + 65536)
        throw new Error(`Access verifier stdin exceeds ${VERIFIER_STDIN_LIMIT} bytes; nothing was verified.`);
      let result;
      try {
        const receipt = verifyGate(readRequest(input));
        result = receipt.items.some(item => item.code === "store-busy") ? { v: 1, code: "store-busy" } : receipt;
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        result = { v: 1, code: error.code, recovery: error.recovery };
      }
      const output = JSON.stringify(result);
      if (Buffer.byteLength(output, "utf8") > VERIFIER_STDOUT_LIMIT) throw new Error("Access verifier output exceeds 60 KiB.");
      process.stdout.write(output + "\n");
    } else if (mode === "check") {
      const option = name => { const at = rest.indexOf(name); return at === -1 ? undefined : rest[at + 1]; };
      const report = rest.length === 1 ? checkReceipt({ receiptPath: rest[0] })
        : checkReceipt({ missionPath: option("--mission"), namespace: option("--namespace"), gate: option("--gate") });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.status === "verified" ? 0 : 2;
    } else throw new Error("Usage: access-receipts.mjs --verify-stdin | check <receipt.json> | check --mission <mission.json> --namespace <ns> --gate <gate>");
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
