import "./loader.mjs";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendLedger, verifyLedger, loopSummaries, readRequest, ledgerPath } from "./ledger.mjs";

const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === names;
// Requests are deliberately outside the hash-chained ledger: observing them never
// publishes a loop/unit record or changes its anchor. Pages fit native CLI stdout.
function observeRequests(input) {
  if (!keys(input, "cursor,invocation") || !Number.isSafeInteger(input.cursor) || input.cursor < 0)
    throw new Error("Invalid execute request observation input.");
  const file = path.join(ledgerPath(process.cwd(), input.invocation), "requests.jsonl");
  let bytes = "", fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error("Execute requests must be a regular file.");
    bytes = readFileSync(fd, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  const lines = bytes ? bytes.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const records = lines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error(`Invalid execute request JSON at line ${index + 1}.`); }
    const short = (value, max) => typeof value === "string" && value.trim().length > 0 &&
      value.length <= max && !/[\x00-\x1f]/.test(value);
    if (!keys(value, "at,invocation,kind,origin,requestId,taskId,v") || value.v !== 1 ||
        value.invocation !== input.invocation || !short(value.requestId, 256) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.taskId ?? "") ||
        !["cancel", "delete"].includes(value.kind) || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.origin ?? "") ||
        !(short(value.at, 64) || typeof value.at === "number" && Number.isFinite(value.at)))
      throw new Error(`Invalid execute request record at line ${index + 1}.`);
    return value;
  });
  if (input.cursor > records.length) throw new Error("Execute request cursor exceeds the current file.");
  const requests = [];
  let cursor = input.cursor, size = 0;
  while (cursor < records.length) {
    const record = records[cursor], length = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (size + length > 48 * 1024) break;
    requests.push(record); size += length; cursor++;
  }
  return { version: 1, ok: true, invocation: input.invocation, requests,
    next: cursor < records.length ? cursor : null };
}
try {
  if (process.argv[2] === "--requests") {
    process.stdout.write(JSON.stringify(observeRequests(readRequest(readFileSync(0, "utf8")))) + "\n");
  } else {
    const { observeCheckout, observationOutput } = await import("./observe.ts");
    const { expected, body, ...extra } = readRequest(readFileSync(0, "utf8"));
    if (Object.keys(extra).length || !keys(expected, "count,head,invocation") ||
        !keys(body, expected.count === 0 ? "record,spec" : "record") ||
        !keys(body.record, "body,kind,loop") || body.record.kind !== "loop")
      throw new Error("Invalid checkout publication request.");
    const { invocation, ...anchor } = expected;
    verifyLedger(process.cwd(), invocation, anchor);
    const observation = observeCheckout();
    if (observation.ok) {
      const { head, fingerprint } = observation.checkout;
      observation.checkout = { head, fingerprint };
    }
    if (!observation.ok) {
      process.stdout.write(observationOutput(observation));
    } else {
      // Format before publication: an oversized observation must not publish.
      const output = observationOutput({ ...observation, ledger: { count: Math.max(1, anchor.count) + 1, head: "0".repeat(64) } });
      if (!JSON.parse(output).ok) process.stdout.write(output);
      else {
        const ledger = appendLedger(process.cwd(), invocation, { expected: anchor, ...body,
          record: { ...body.record, body: { ...body.record.body, observation } } });
        process.stdout.write(observationOutput({ ...observation, ledger,
          summaries: loopSummaries(process.cwd(), invocation, ledger) }));
      }
    }
  }
} catch (error) {
  if (process.argv[2] === "--requests") {
    process.stdout.write(JSON.stringify({ version: 1, ok: false, reason: String(error.message).slice(0, 2048) }) + "\n");
  } else {
    const integrity = error.code === "ENOENT" || /Ledger (?:publication conflict|head mismatch|spec (?:digest|origin) mismatch|has a gap|path traverses)|Invalid ledger record or chain link|Noncanonical ledger record/.test(error.message);
    process.stdout.write(JSON.stringify({ version: 1, ok: false, reason: String(error.message).slice(0, 2048),
      nextStep: integrity ? "Human reconciliation required: ledger integrity cannot be repaired automatically." : "Retry the frozen checkout publication request.",
      ...(integrity ? { error: "ledger-integrity" } : {}) }) + "\n");
  }
}
