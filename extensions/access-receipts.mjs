// Deterministic access receipts: the workflow-dispatched verifier compares each
// published original with the value the workflow admitted, and the read-only
// tool/CLI recompute current digests later. No model creates or copies receipts.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalDigest, canonicalJSON, jsonDifferences, sha256 } from "./canonical.mjs";

/** Verifier stdin bound (the workflow checks it before dispatch); exceeding it fails, never truncates. */
export const VERIFIER_STDIN_LIMIT = 1024 * 1024;
/** Verifier stdout bound, below the native external-cli capture ceiling. */
export const VERIFIER_STDOUT_LIMIT = 60 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeSegment = value => typeof value === "string" && SEGMENT.test(value) && !value.includes("..");

/** Receipts live in the native mission directory and follow its retention. */
export function receiptLocation(missionPath, namespace, gate) {
  if (typeof missionPath !== "string" || !path.isAbsolute(missionPath) || missionPath.includes("\0") ||
      !missionPath.endsWith(".json") || !safeSegment(path.basename(missionPath, ".json")))
    throw new Error("Access receipts require the absolute native mission record path.");
  if (!safeSegment(namespace) || !safeSegment(gate)) throw new Error("Invalid access receipt namespace or gate.");
  const missionDirectory = path.join(path.dirname(missionPath), path.basename(missionPath, ".json"));
  return { missionDirectory, receiptPath: path.join(missionDirectory, "receipts", namespace, `${gate}.json`) };
}

// Only execute re-verifies a blocked gate under a new .rN gate on relaunch.
// Standalone review refuses retained state and architecture reuses the same
// gate, so for them a restored original cannot resume the same pass.
export const resumableNamespace = namespace => typeof namespace === "string" && namespace.startsWith("execute-");
const NEW_PASS = "start a new consultation/mission";
export function accessAction(cause, resumable) {
  const restore = what => resumable ? `${what} and resume execute, or ${NEW_PASS}.` : `This pass cannot resume: ${NEW_PASS}.`;
  switch (cause) {
    case "missing-file": return `${restore("Restore the published original from its native run artifacts")} Do not recreate it by hand.`;
    case "parse-error": return `${restore("Restore the published original from its native run artifacts")} Do not repair it by hand.`;
    case "content-differs": return `Decide which version is authoritative. ${restore("Return the published file to the admitted value")} The workflow does not choose a version.`;
    case "output-save-error": return `Native publication failed, so no original can be verified. ${NEW_PASS[0].toUpperCase()}${NEW_PASS.slice(1)}; inspect the native run for the save error.`;
    case "retained-incompatible": return `The retained state belongs to an incompatible Pitako contract. ${NEW_PASS[0].toUpperCase()}${NEW_PASS.slice(1)}.`;
    case "verifier-failed": return `Verification did not run; the original was not judged unavailable. Inspect the pitako.access-verifier run and resolve its failure, then ${resumable ? "resume" : NEW_PASS}.`;
    default: return NEW_PASS;
  }
}

/** One explanation format for every cause, workflow- or verifier-detected. */
export function explainAccess({ state, cause, id, key, path: file, pointers = [], expectedDigest, digest }, resumable = false) {
  return `Original ${id} (key ${key ?? "unknown"}, path ${file ?? "none"}) is ${state}: ${cause}.` +
    (expectedDigest ? ` Expected digest: ${expectedDigest}; actual digest: ${digest}.` : "") +
    (pointers.length ? ` Differing JSON pointers: ${pointers.join(", ")}.` : "") + ` Action: ${accessAction(cause, resumable)}`;
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
        Object.keys(item).some(field => !["id", "key", "path", "admitted", "digest"].includes(field)) ||
        typeof item.id !== "string" || !item.id || typeof item.key !== "string" || !item.key ||
        typeof item.path !== "string" || !path.isAbsolute(item.path) || item.path.includes("\0") ||
        (Object.hasOwn(item, "admitted") === Object.hasOwn(item, "digest")) ||
        (Object.hasOwn(item, "digest") && (typeof item.digest !== "string" || !/^[a-f0-9]{64}$/i.test(item.digest)))) ||
      new Set(request.items.map(item => item.id)).size !== request.items.length)
    throw new Error("Invalid access verifier request: expected {missionPath, namespace, gate, items:[{id, key, path, admitted|digest}]}.");
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

/** Verify one consuming gate and publish its no-clobber receipt. */
export function verifyGate(request) {
  validateRequest(request);
  const { receiptPath } = receiptLocation(request.missionPath, request.namespace, request.gate);
  const items = request.items.map(verifyItem).map(({ expectedDigest, ...item }) => ({ ...item,
    explanation: item.state === "accessible" ? "Published original equals the admitted value." : explainAccess({ ...item, expectedDigest }, resumableNamespace(request.namespace)) }));
  const receipt = { v: 1, namespace: request.namespace, gate: request.gate,
    items: items.map(({ pointers, ...item }) => ({ ...item, pointers })) };
  const bytes = canonicalJSON(receipt) + "\n";
  const outcome = publish(receiptPath, bytes);
  const retained = readFileSync(receiptPath, "utf8");
  return { v: 1, outcome, receipt: { path: receiptPath, digest: sha256(retained) },
    ...(outcome === "conflict" ? { explanation: `Access receipt ${receiptPath} already exists with different content for gate ${request.gate}. A changed published original was re-verified under the same gate. ${resumableNamespace(request.namespace) ? "Restore the original to its verified bytes and resume, or start a new consultation/mission." : "This pass cannot resume under that gate: start a new consultation/mission."}` } : {}),
    items: items.map(({ id, state, cause, digest, explanation }) => ({ id, state, cause, digest, ...(state === "accessible" ? {} : { explanation }) })) };
}

/** Read-only recomputation of current digests against a receipt; reports drift and pruning. */
export function checkReceipt(input) {
  const location = typeof input?.receiptPath === "string" ? { receiptPath: path.resolve(input.receiptPath),
    missionDirectory: path.dirname(path.dirname(path.dirname(path.resolve(input.receiptPath)))) }
    : receiptLocation(input?.missionPath, input?.namespace, input?.gate);
  if (!existsSync(location.receiptPath)) return existsSync(location.missionDirectory)
    ? { status: "missing", receipt: { path: location.receiptPath }, reason: "receipt not found for this gate" }
    : { status: "unavailable", receipt: { path: location.receiptPath }, reason: "receipt unavailable (mission pruned)" };
  const bytes = readFileSync(location.receiptPath, "utf8");
  let receipt;
  try { receipt = JSON.parse(bytes); } catch { receipt = undefined; }
  if (!record(receipt) || receipt.v !== 1 || !Array.isArray(receipt.items) || canonicalJSON(receipt) + "\n" !== bytes)
    return { status: "invalid", receipt: { path: location.receiptPath, digest: sha256(bytes) }, reason: "receipt is not a canonical v1 access receipt" };
  const items = receipt.items.map(item => {
    if (item.state !== "accessible") return { id: item.id, path: item.path, state: item.state, current: "not-verified", explanation: item.explanation };
    let current;
    try { current = canonicalDigest(JSON.parse(readFileSync(item.path, "utf8"))); }
    catch (error) { return { id: item.id, path: item.path, state: item.state, current: error?.code === "ENOENT" ? "missing" : "unparsable" }; }
    return { id: item.id, path: item.path, state: item.state, current: current === item.digest ? "unchanged" : "drift",
      ...(current === item.digest ? {} : { expectedDigest: item.digest, currentDigest: current }) };
  });
  const status = items.some(item => item.state !== "accessible") ? "blocked"
    : items.every(item => item.current === "unchanged") ? "verified" : "drift";
  return { status, receipt: { path: location.receiptPath, digest: sha256(bytes), namespace: receipt.namespace, gate: receipt.gate }, items };
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
      const output = JSON.stringify(verifyGate(readRequest(input)));
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
