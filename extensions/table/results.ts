import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Type } from "typebox";

export const AUTOMATIC_BYTES = 4096, PAGE_BYTES = 16384;
export const resultSections = ["report", "judgment", "history", "findings", "responses", "grounds", "pending", "failures", "limits", "observations", "host", "snapshot", "members", "messages", "closure", "delivery", "controls", "state", "archive"] as const;
export type ResultSection = typeof resultSections[number];
export type TableRead = { section?: ResultSection; maxBytes?: number; cursor?: never } | { cursor: string; section?: never; maxBytes?: never };
export const tableReadProperties = {
  section: Type.Optional(Type.Union(resultSections.map(section => Type.Literal(section)))),
  maxBytes: Type.Optional(Type.Integer({ minimum: AUTOMATIC_BYTES, maximum: PAGE_BYTES })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
};
export interface TableSemanticReport {
  protocol: "architecture" | "review";
  judgment: unknown | null;
  [key: string]: unknown;
}
/** Host capability installed at reservation, not inferred from role or driver text. */
export interface TableRootRegistration {
  protocol: TableSemanticReport["protocol"];
  archive?: import("./archive.ts").ArchiveDestination;
  semantic?: () => TableSemanticReport;
  diagnostic?: () => unknown;
}
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
export const tableTool = (payload: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  details: { table: true }, ...(isError ? { isError: true } : {}),
});
export type TableToolResult = ReturnType<typeof tableTool>;

/** Only bounded metadata is duplicated. Measure the original final envelope. */
export function tableIncidental(payload: Record<string, unknown>) {
  const envelope = { content: [{ type: "text" as const, text: "Table operation." }], details: { table: true, ...payload } };
  if (jsonBytes(envelope) > AUTOMATIC_BYTES) throw new Error("table incidental envelope exceeds budget");
  return envelope;
}
export function tableError(error: unknown): TableToolResult {
  const original = String(error);
  let end = Math.min(original.length, 1024);
  while (end && /[\uD800-\uDBFF]/.test(original[end - 1]!)) --end;
  const envelope = tableTool({ error: "table_request_failed", message: original.slice(0, end), truncated: end < original.length }, true);
  // Escaping control characters twice can expand even a short message.
  if (jsonBytes(envelope) > AUTOMATIC_BYTES) return tableTool({ error: "table_request_failed", truncated: true }, true);
  return envelope;
}
function budgetOf(value = PAGE_BYTES) {
  if (!Number.isSafeInteger(value) || value < AUTOMATIC_BYTES || value > PAGE_BYTES) throw new Error("invalid table byte budget");
  return value;
}
function sectionOf(value: unknown): ResultSection {
  if (!resultSections.includes(value as ResultSection)) throw new Error("invalid table section");
  return value as ResultSection;
}
const boundary = (text: string, end: number) => end > 0 && end < text.length &&
  /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!) ? end - 1 : end;

/** One immutable serialization and private cursor key, owned by a result or a diagnostic cut. */
export function sealPages(value: unknown, id: string = randomUUID()) {
  const report = JSON.stringify(value);
  const snapshot = JSON.parse(report) as Record<string, unknown>;
  const key = randomBytes(32);
  const sign = (body: string) => createHmac("sha256", key).update(body).digest("base64url");
  const encode = (section: ResultSection, offset: number, budget: number) => {
    const body = Buffer.from(JSON.stringify([id, section, offset, budget])).toString("base64url");
    return `${body}.${sign(body)}`;
  };
  const header = (section: ResultSection, complete: boolean) => ({ id, section, complete, acceptance: false });
  return {
    id, canonical: report,
    /** Used by both automatic delivery and explicit report reads. */
    inline<T>(wrap: (payload: unknown) => T, budget = AUTOMATIC_BYTES): T {
      const complete = wrap({ header: header("report", true), report: snapshot });
      if (jsonBytes(complete) <= budget) return complete;
      const notice = wrap({ header: header("report", false), notice: "Read pertinent sections with team_result before dependent judgment." });
      if (jsonBytes(notice) > budget) throw new Error("table header exceeds budget");
      return notice;
    },
    read(options: TableRead = {}): TableToolResult {
      let section: ResultSection, offset = 0, budget: number;
      if ("cursor" in options && options.cursor !== undefined) {
        if (options.section !== undefined || options.maxBytes !== undefined || typeof options.cursor !== "string" || options.cursor.length > 1024)
          throw new Error("invalid table cursor");
        const [body, signature, extra] = options.cursor.split(".");
        if (!body || !signature || extra || sign(body) !== signature) throw new Error("invalid or replaced table cursor");
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("invalid table cursor"); }
        if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== id || !Number.isSafeInteger(decoded[2]) || decoded[2] < 0)
          throw new Error("invalid or foreign table cursor");
        section = sectionOf(decoded[1]); offset = decoded[2]; budget = budgetOf(decoded[3]);
      } else {
        section = sectionOf(options.section ?? "report"); budget = budgetOf(options.maxBytes);
      }
      const text = section === "report" ? report : JSON.stringify(snapshot[section] ?? null);
      if (offset > text.length || boundary(text, offset) !== offset) throw new Error("invalid table cursor position");
      const wrap = (end: number) => tableTool({ header: {
        ...header(section, end === text.length), offset, end, total: text.length, maxBytes: budget,
        cursor: end < text.length ? encode(section, end, budget) : null,
      }, fragment: text.slice(offset, end) });
      let low = offset, high = Math.min(text.length, offset + budget);
      // Search UTF-16 positions, then cut at a code-point boundary. JSON escaping is monotone.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (jsonBytes(wrap(boundary(text, mid))) <= budget) low = mid; else high = mid - 1;
      }
      const end = boundary(text, low);
      if (end === offset && offset < text.length) throw new Error("table page cannot advance");
      const envelope = wrap(end);
      if (jsonBytes(envelope) > budget) throw new Error("table page exceeds budget");
      return envelope;
    },
  };
}
export type SealedPages = ReturnType<typeof sealPages>;
