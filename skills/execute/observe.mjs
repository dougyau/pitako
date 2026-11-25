import "./loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendLedger, commitExecute, executeEpoch, withExecuteStore, verifyLedger, loopSummaries, ledgerProjection, readRequest } from "./ledger.mjs";
import { canonicalDigest } from "../../extensions/canonical.mjs";
import { resolveClosingPublication } from "./closing.mjs";
const { StoreError, readTodoRecords } = await import("../../extensions/pitako-store.ts");

const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === names;
// Requests are in a separate scope: observing them never
// publishes a loop/unit record or changes its anchor. Pages fit native CLI stdout.
export function observeRequests(input) {
  const { epoch, ...request } = input;
  if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0))
    throw new Error("Invalid execute request epoch.");
  input = request;
  const observation = input.observation;
  if (!(keys(input, "cursor,invocation") || keys(input, "cursor,invocation,observation")) ||
      !Number.isSafeInteger(input.cursor) || input.cursor < 0 ||
      observation !== undefined && (!keys(observation, "input,key,number") ||
        !Number.isSafeInteger(observation.number) || observation.number < 1 ||
        typeof observation.key !== "string" || observation.key.length > 192 ||
        !keys(observation.input, "digest,seq") || !Number.isSafeInteger(observation.input.seq) ||
        observation.input.seq < 1 || !/^[a-f0-9]{64}$/.test(observation.input.digest)))
    throw new Error("Invalid execute request observation input.");
  const records = readTodoRecords(process.cwd(), input.invocation, "request");
  for (const [index, value] of records.entries()) {
    const short = (value, max) => typeof value === "string" && value.trim().length > 0 &&
      value.length <= max && !/[\x00-\x1f]/.test(value);
    if (!keys(value, "at,invocation,kind,origin,requestId,taskId,v") || value.v !== 1 ||
        value.invocation !== input.invocation || !short(value.requestId, 256) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.taskId ?? "") ||
        !["cancel", "delete"].includes(value.kind) || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.origin ?? "") ||
        !(short(value.at, 64) || typeof value.at === "number" && Number.isFinite(value.at)))
      throw new Error(`Invalid execute request record at index ${index}.`);
  }
  if (input.cursor > records.length) throw new Error("Execute request cursor exceeds the current request count.");
  const requests = [];
  let cursor = input.cursor, size = 0;
  while (cursor < records.length) {
    const record = records[cursor], length = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (size + length > 48 * 1024) break;
    requests.push(record); size += length; cursor++;
  }
  const result = { version: 1, ok: true, invocation: input.invocation, requests,
    next: cursor < records.length ? cursor : null };
  const digest = canonicalDigest(result);
  const saved = commitExecute(process.cwd(), input.invocation, observation ? `requests:${observation.key}:${input.cursor}` :
    `requests:${input.cursor}:${digest}`, observation ? canonicalDigest(input) : digest,
    "observation", { operation: "requests", result, ...(observation ? { observation } : {}) });
  return saved.result.result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) try {
  if (process.argv[2] === "--requests") {
    const { storeId, expectedHead, ...request } = readRequest(readFileSync(0, "utf8"));
    const result = await withExecuteStore(process.cwd(), request.invocation, () => observeRequests(request),
      request.epoch ?? (request.observation ? executeEpoch(request.invocation, request.observation.key) : 0),
      storeId ? { storeId, expectedHead } : undefined);
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    const { observeCheckout, observationOutput } = await import("./observe.ts");
    const request = readRequest(readFileSync(0, "utf8"));
    // Without a compliance child, bind the epoch from the committed input ref
    // so launch and relaunch keep the exact same native checkout params.
    const epoch = request.compliance ? executeEpoch(request.invocation, request.compliance.key) :
      request.compliance === null && request.input && request.storeId ? null : 0;
    await withExecuteStore(process.cwd(), request.invocation ?? request.expected?.invocation, () => {
    const publication = request.input ? resolveClosingPublication(process.cwd(), request) : request;
    const { admission, expected, body, ...extra } = publication;
    if (!request.input && admission !== undefined) throw new Error("Invalid checkout publication request.");
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
        const summaries = loopSummaries(process.cwd(), invocation, ledger);
        const store = ledgerProjection(process.cwd(), invocation, ledger);
        if (body.record.body.kind === "final") {
          store.P.control = { ...store.P.control, ledger };
          store.P.prompt = { ...store.P.prompt, admission,
            closing: { body: { ...body.record.body, observation }, summaries } };
        }
        process.stdout.write(observationOutput({ ...observation, ledger,
          summaries, store }));
      }
    }
    }, epoch,
    request.storeId ? { storeId: request.storeId, expectedHead: { seq: request.input.seq, hash: request.input.digest } } : undefined);
  }
} catch (error) {
  const storeFailure = error instanceof StoreError ? { code: error.code, recovery: error.recovery } : {};
  if (process.argv[2] === "--requests") {
    process.stdout.write(JSON.stringify({ version: 1, ok: false, reason: String(error.message).slice(0, 2048), ...storeFailure }) + "\n");
  } else {
    const integrity = error.code === "ENOENT" || /Closing .*integrity|Ledger (?:publication conflict|head mismatch|spec (?:digest|origin) mismatch|has a gap|path traverses)|Invalid ledger record or chain link|Noncanonical ledger record/.test(error.message);
    process.stdout.write(JSON.stringify({ version: 1, ok: false, reason: String(error.message).slice(0, 2048),
      nextStep: integrity ? "Retain the integrity failure and exact original references; do not republish." : "Retry the frozen checkout publication request.",
      ...(integrity ? { error: "ledger-integrity" } : {}), ...storeFailure }) + "\n");
  }
}
