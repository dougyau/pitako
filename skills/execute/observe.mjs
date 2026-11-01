import "./loader.mjs";
import { readFileSync } from "node:fs";
import { appendLedger, verifyLedger, loopSummaries, readRequest } from "./ledger.mjs";

const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === names;
try {
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
} catch (error) {
  const integrity = error.code === "ENOENT" || /Ledger (?:publication conflict|head mismatch|spec (?:digest|origin) mismatch|has a gap|path traverses)|Invalid ledger record or chain link|Noncanonical ledger record/.test(error.message);
  process.stdout.write(JSON.stringify({ version: 1, ok: false, reason: String(error.message).slice(0, 2048),
    nextStep: integrity ? "Human reconciliation required: ledger integrity cannot be repaired automatically." : "Retry the frozen checkout publication request.",
    ...(integrity ? { error: "ledger-integrity" } : {}) }) + "\n");
}
