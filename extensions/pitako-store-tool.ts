import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { PitakoStore, StoreError } from "./pitako-store.ts";

const Head = Type.Union([Type.Null(), Type.Object({
  seq: Type.Integer({ minimum: 1 }), hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false })]);
const parameters = Type.Object({
  op: Type.Union([Type.Literal("head"), Type.Literal("records"), Type.Literal("record"),
    Type.Literal("blob"), Type.Literal("ledger"), Type.Literal("receipts"), Type.Literal("verify")]),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  head: Type.Optional(Head),
  storeId: Type.Optional(Type.String({ maxLength: 64 })),
  seq: Type.Optional(Type.Integer({ minimum: 1 })),
  digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });

/** Fragments use byte offsets and base64 so arbitrary JSON and binary evidence round-trip exactly. */
export function readStorePage(cwd: string, input: Static<typeof parameters>) {
  const store = new PitakoStore(cwd);
  const op = input.op;
  if (!["head", "records", "record", "blob", "ledger", "receipts", "verify"].includes(op))
    throw new Error("Unknown store operation.");
  for (const [value, min, max] of [[input.limit ?? 50, 1, 50], [input.index ?? 0, 0, Number.MAX_SAFE_INTEGER],
    [input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER]] as const)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid page bounds.");
  const snapshot = op === "blob" ? store.readBlob(input.digest ?? "") :
    op === "verify" ? { identity: store.verify() } :
    store.read(input.scope ?? "", input.head);
  if (input.storeId && snapshot.identity.storeId !== input.storeId)
    throw new StoreError("store-replaced", "Store was replaced.");
  const base = { status: "ok", op, ...snapshot.identity,
    ...("head" in snapshot ? { head: snapshot.head } : {}) };
  if (op === "head" || op === "verify") return base;
  const rows = "records" in snapshot ? snapshot.records.filter(row =>
    op === "record" ? row.seq === input.seq :
    op === "ledger" ? row.kind === "ledger" :
    op === "receipts" ? row.kind === "receipt" : true) : [];
  if (op === "record" && rows.length === 0) throw new StoreError("store-unavailable", "Record does not exist.");
  const values = "bytes" in snapshot ? [snapshot.bytes] : rows;
  let index = input.index ?? 0, offset = input.offset ?? 0;
  // Leave room for Pi's text/details/structured mirrors as well as the continuation.
  let budget = 15 * 1024 - Buffer.byteLength(JSON.stringify(base)) - 1024;
  if (index > values.length || index === values.length && offset !== 0) throw new Error("Invalid page position.");
  const items = [];
  while (index < values.length && items.length < (input.limit ?? 50) && budget > 0) {
    const value = values[index]!;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    if (offset > bytes.length || offset === bytes.length && offset !== 0) throw new Error("Invalid byte offset.");
    const fragment = { index, offset, totalBytes: bytes.length, encoding: "base64", data: "" };
    const available = Math.floor((budget - Buffer.byteLength(JSON.stringify(fragment)) - 1) / 4) * 3;
    if (available <= 0) break;
    const end = Math.min(bytes.length, offset + available);
    fragment.data = bytes.subarray(offset, end).toString("base64");
    items.push(fragment);
    budget -= Buffer.byteLength(JSON.stringify(fragment)) + 1;
    if (end === bytes.length) { index++; offset = 0; } else offset = end;
  }
  const result = { ...base, items,
    ...("bytes" in snapshot ? { digest: snapshot.digest, size: snapshot.size,
      originalSize: snapshot.originalSize, truncated: snapshot.truncated } : {}),
    next: index < values.length ? { index, offset, storeId: snapshot.identity.storeId,
      ...("head" in snapshot ? { head: snapshot.head } : {}) } : null };
  if (Buffer.byteLength(JSON.stringify(result)) > 50 * 1024) throw new Error("Page metadata exceeds 50 KiB.");
  return result;
}

export default function pitakoStoreTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pitako_store", label: "pitako_store",
    description: "Read-only verified cwd-local history: head, records, record (seq), blob (digest), ledger (kind ledger), receipts (kind receipt), verify. Maximum 50 items/50 KiB. Items are base64 byte fragments of JSON records or raw blob bytes; concatenate in index/offset order before decoding. Repeat the same request with next fields until next=null. Pin head and storeId for stable record paging; omit head only for an explicit tip observation. Never creates, repairs or quarantines.",
    parameters,
    outputSchema: Type.Object({ status: Type.String() }, { additionalProperties: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(_id, input, _signal, _update, ctx) {
      let report: unknown;
      let isError = false;
      try { report = readStorePage(ctx.cwd, input); }
      catch (error) {
        isError = true;
        report = { status: "unavailable", code: error instanceof StoreError ? error.code : "invalid-input" };
      }
      const result = { content: [{ type: "text" as const, text: JSON.stringify(report) }],
        structuredContent: JSON.parse(JSON.stringify(report)), details: report, isError };
      if (Buffer.byteLength(JSON.stringify(result)) > 50 * 1024)
        throw new Error("Store response exceeds 50 KiB.");
      return result;
    },
  });
}
