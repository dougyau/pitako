import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, opendirSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HistoryGroup, HistoryMember } from "./history.ts";
import { catalogValues, checkJson, fileCut, HISTORY_BYTES, HISTORY_FRAGMENT, jsonState, validateCut, window, type FileCut, type JsonState } from "./history-native.ts";

export type HistoryQuery =
  | { action: "list"; scope?: "all"; coordinatorSessionId?: string; missionId?: string;
      assignmentId?: string; instanceId?: string; roleId?: string; unitId?: string; attemptId?: string; cursor?: string; limit?: number }
  | { action: "read"; historyId: string; groupId?: string; cursor?: string; limit?: number };
export interface HistoryPage {
  items: unknown[];
  diagnostics: Array<{ code: string; detail?: string }>;
  cursor: string | null;
}
type Cursor = { version: 1; action: "list" | "read"; identity: string; groupId: string;
  index: number; entryOffset?: number; cut: FileCut; json?: JsonState; catalogOnly?: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const selectors = ["coordinatorSessionId", "missionId", "assignmentId", "instanceId", "roleId", "unitId", "attemptId"] as const;
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decode(token: string | undefined, action: Cursor["action"], identity: string): Cursor | undefined {
  if (token === undefined) return undefined;
  if (token.length > 2048 || !/^[\w-]+$/.test(token)) throw new Error("invalid_cursor");
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
  catch { throw new Error("invalid_cursor"); }
  if (!cursor || typeof cursor !== "object") throw new Error("invalid_cursor");
  if (cursor.version !== 1 || cursor.action !== action || cursor.identity !== identity || !UUID.test(cursor.groupId) ||
      !Number.isSafeInteger(cursor.index) || cursor.index < 0 || !cursor.cut ||
      ![cursor.cut.dev, cursor.cut.ino, cursor.cut.birth, cursor.cut.size, cursor.cut.modified].every(Number.isFinite) ||
      !Number.isSafeInteger(cursor.cut.size) || cursor.cut.size < 0 || !/^[a-f0-9]{64}$/.test(cursor.cut.edge) ||
      action === "read" && (!Number.isSafeInteger(cursor.entryOffset) || cursor.entryOffset! < 0 ||
        cursor.entryOffset! > cursor.index || cursor.index > cursor.cut.size)) throw new Error("invalid_cursor");
  if (action === "read" && (!cursor.json || !Array.isArray(cursor.json.stack) || cursor.json.stack.length > 32 ||
    !cursor.json.stack.every((phase) => ["oKeyOrEnd", "oKey", "oColon", "oValue", "oSeparator", "aValueOrEnd", "aValue", "aSeparator"].includes(phase)) ||
    !["value", "done"].includes(cursor.json.root) || (cursor.json.scalar?.length ?? 0) > 256)) throw new Error("invalid_cursor");
  return cursor;
}

/** Known host catalog only; no constructor that mkdir/chmods on a query. */
function* groupIds(directory: string, after = ""): Generator<string> {
  // Constant memory, deterministic UUID ordering. Catalog enumeration is not disk discovery.
  while (true) {
    let next: string | undefined;
    let dir;
    try { dir = opendirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        const id = entry.name.slice(0, -5);
        if (entry.name.endsWith(".json") && UUID.test(id) && id > after && (!next || id < next)) next = id;
      }
    } finally { dir.closeSync(); }
    if (!next) return;
    yield next;
    after = next;
  }
}

function catalog(directory: string, id: string) {
  const file = path.join(directory, `${id}.json`);
  if (!lstatSync(file).isFile()) throw new Error("unreadable_catalog");
  return openSync(file, "r");
}

function metadata(fd: number, groupId: string): HistoryGroup {
  const fields: Record<string, unknown> = {};
  for (const row of catalogValues(fd)) if (row.key !== "members") fields[row.key] = row.value;
  const identity = fields.identity as HistoryGroup["identity"] | undefined;
  const closure = fields.closure as HistoryGroup["closure"] | undefined;
  const store = fields.missionStore as HistoryGroup["missionStore"];
  if (fields.version !== 1 || fields.groupId !== groupId || typeof fields.workspace !== "string" ||
    !["complete", "partial"].includes(String(fields.coverage)) || !identity ||
    !(identity.kind === "invocation" && typeof identity.invocationId === "string" ||
      identity.kind === "execution" && typeof identity.executionRoot === "string" && typeof identity.executionRef === "string" ||
      identity.kind === "mission" && typeof identity.storeRoot === "string" && typeof identity.missionId === "string") ||
    !closure || !(closure.state === "unclosed" || closure.state === "unknown" && typeof closure.reason === "string" ||
      closure.state === "closed" && typeof closure.closedAt === "string" && typeof closure.evidenceRef === "string") ||
    store && ![store.dbPath, store.objectDir, store.sessionsDirectory].every((value) => typeof value === "string" && value))
    throw new Error("incompatible_catalog");
  return { ...fields, members: [] } as unknown as HistoryGroup;
}

function* members(fd: number): Generator<{ member: HistoryMember; index: number }> {
  for (const row of catalogValues(fd)) if (row.key === "members") {
    const member = row.value as HistoryMember;
    if (!member || !UUID.test(member.historyId) || typeof member.roleId !== "string" || typeof member.admittedAt !== "string" ||
      !Array.isArray(member.gaps) || !member.gaps.every((gap) => typeof gap === "string") || !member.native ||
      !(member.native.state === "not-created" || member.native.state === "pruned" || member.native.state === "allocated" &&
        typeof member.native.path === "string" && typeof member.native.sessionId === "string" && member.native.disposition &&
        ["pending", "disposed", "unknown"].includes(member.native.disposition.state)))
      throw new Error("corrupt_catalog");
    yield { member, index: row.index! };
  }
}

function matches(query: Extract<HistoryQuery, { action: "list" }>, group: HistoryGroup, member: HistoryMember): boolean {
  return selectors.every((key) => query[key] === undefined || (key === "missionId"
    ? group.identity.kind === "mission" && group.identity.missionId === query.missionId
    : member[key] === query[key]));
}

function add(page: HistoryPage, item: unknown, cursor: Cursor): boolean {
  // Reserve room for diagnostics and the continuation, measuring bytes rather than JS characters.
  if (Buffer.byteLength(JSON.stringify({ ...page, items: [...page.items, item], cursor: encode(cursor) })) > HISTORY_BYTES - 4096)
    return false;
  page.items.push(item);
  return true;
}

function summary(group: HistoryGroup, member: HistoryMember) {
  const { native, gaps, coordinatorSessionFile, ...identity } = member;
  return { kind: "member", groupId: group.groupId, ...identity,
    native: native.state === "allocated" ? { state: native.state, sessionId: native.sessionId, disposition: native.disposition } : native,
    gaps };
}

async function list(query: Extract<HistoryQuery, { action: "list" }>, page: HistoryPage, directory: string, limit: number) {
  const identity = createHash("sha256").update(JSON.stringify(selectors.map((key) => query[key] ?? null))).digest("hex");
  const previous = decode(query.cursor, "list", identity);
  let scans = 0;
  const ids = previous ? function* () { yield previous.groupId; yield* groupIds(directory, previous.groupId); }() : groupIds(directory);
  for (const groupId of ids) {
    const fd = catalog(directory, groupId);
    try {
      const cut = fileCut(fd);
      if (previous?.groupId === groupId) validateCut(fd, previous.cut);
      const group = metadata(fd, groupId);
      if (query.missionId && (group.identity.kind !== "mission" || group.identity.missionId !== query.missionId)) continue;
      let catalogCount = 0;
      for (const row of members(fd)) catalogCount = row.index + 1;
      const start = previous?.groupId === groupId ? previous.index : 0;
      if (previous?.groupId === groupId && group.identity.kind === "mission" && !previous.catalogOnly)
        throw new Error("legacy_projection_cursor");
      const authority = group.identity.kind === "mission"
        ? { archive: "archived/catalog-only", closure: { state: "unknown", reason: "retired runtime; catalog provenance only" },
            protected: true, recordedCoverage: group.coverage, recordedClosure: group.closure }
        : { closure: group.closure, protected: group.closure.state !== "closed" };
      const current = (index: number): Cursor => ({ version: 1, action: "list", identity, groupId, cut, index, catalogOnly: true });
      let last = start;
      const matchesEmpty = !selectors.filter((key) => key !== "missionId").some((key) => query[key] !== undefined) &&
        (!query.missionId || group.identity.kind === "mission" && group.identity.missionId === query.missionId);
      if (!catalogCount && start === 0 && matchesEmpty) {
        const item = { kind: "group", groupId, identity: group.identity, workspace: group.workspace,
          ...(group.identity.kind === "mission" ? {} : { coverage: group.coverage }), ...authority, historyState: "no_member_record" };
        if (page.items.length >= limit || !add(page, item, current(1))) {
          if (!page.items.length) throw new Error("summary_limit");
          page.cursor = encode(current(0)); return;
        }
        last = 1;
      }
      for (const { member, index } of members(fd)) {
        if (index < start) continue;
        last = index;
        if (!matches(query, group, member)) continue;
        const item = { ...summary(group, member), ...(group.prunedAt ? { historyState: "pruned" } : group.cleanup ? { historyState: "deleting" } : {}),
          group: { groupId, identity: group.identity, workspace: group.workspace,
          ...(group.identity.kind === "mission" ? {} : { coverage: group.coverage }), ...authority } };
        if (page.items.length >= limit || !add(page, item, current(index + 1))) {
          // A single summary that cannot fit is explicit, not an endless cursor.
          if (!page.items.length)
            throw new Error("summary_limit");
          page.cursor = encode(current(index)); return;
        }
        last = index + 1;
      }
      validateCut(fd, cut);
      if (++scans >= 200) {
        page.diagnostics.push({ code: "catalog_scan_limit" });
        page.cursor = encode(current(last)); return;
      }
    } finally { closeSync(fd); }
  }
}

function sidecar(file: string): { code: string } {
  try {
    const stat = lstatSync(`${file}.acp.json`);
    if (!stat.isFile()) return { code: "sidecar_unreadable" };
    const fd = openSync(`${file}.acp.json`, "r");
    closeSync(fd);
    return { code: "sidecar_present_not_consulted" };
  } catch (error) {
    return { code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "sidecar_missing" : "sidecar_unreadable" };
  }
}

async function locate(directory: string, historyId: string, selectedGroup?: string): Promise<{ member: HistoryMember; groupId: string; deleting?: boolean } | undefined> {
  for (const groupId of selectedGroup ? [selectedGroup] : groupIds(directory)) {
    const fd = catalog(directory, groupId);
    try {
      const group = metadata(fd, groupId);
      for (const { member } of members(fd)) if (member.historyId === historyId) return { member, groupId, deleting: Boolean(group.cleanup) };
    } finally { closeSync(fd); }
  }
  return undefined;
}

async function read(query: Extract<HistoryQuery, { action: "read" }>, page: HistoryPage, directory: string, limit: number) {
  if (!UUID.test(query.historyId)) throw new Error("invalid_history_id");
  if (query.groupId !== undefined && !UUID.test(query.groupId)) throw new Error("invalid_group_id");
  const previous = decode(query.cursor, "read", query.historyId);
  const found = await locate(directory, query.historyId, query.groupId);
  if (!found) throw new Error(previous ? "stale_cursor" : "history_not_found");
  const { member, groupId } = found;
  if (previous && previous.groupId !== groupId) throw new Error("stale_cursor");
  if (found.deleting) page.diagnostics.push({ code: "history_deletion_incomplete" });
  if (member.native.state === "pruned") {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: "history_pruned" }); return;
  }
  if (member.gaps?.length) page.diagnostics.push({ code: "capture_gaps",
    detail: `${member.gaps.join("; ").slice(0, 1024)} (catalog diagnostics; detail limited to 1024 characters)` });
  if (member.native.state === "not-created") {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: "native_not_created", detail: "No allocated native locator was recorded; this is not proof of no worker activity." }); return;
  }
  const file = member.native.path;
  page.diagnostics.push(sidecar(file));
  let fd: number;
  try {
    if (!lstatSync(file).isFile()) throw new Error("native_unreadable");
    fd = openSync(file, "r");
  } catch (error) {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? member.terminal?.beforeFirstAssistant ? "native_not_persisted_before_assistant" : "native_missing" : "native_unreadable" });
    return;
  }
  try {
    if (previous) validateCut(fd, previous.cut);
    const cut = previous?.cut ?? fileCut(fd);
    let offset = previous?.index ?? 0;
    let entryOffset = previous?.entryOffset ?? 0;
    let json = previous?.json ?? jsonState();
    if (!cut.size) page.diagnostics.push({ code: "native_empty" });
    if (cut.size && window(fd, cut.size - 1, 1)[0] !== 10) page.diagnostics.push({ code: "partial_tail" });
    page.diagnostics.push({ code: "native_physical_order",
      detail: "Base64 fragments concatenate losslessly by byteOffset; entryOffset identifies a JSONL record. All branches/actions included. Upstream truncation and unavailable external artifacts cannot be recovered." });
    while (offset < cut.size && page.items.length < limit) {
      const chunks: Buffer[] = [];
      let length = 0;
      let end = false;
      while (length < HISTORY_FRAGMENT && offset + length < cut.size && !end) {
        let bytes = window(fd, offset + length, Math.min(HISTORY_FRAGMENT - length, cut.size - offset - length));
        const newline = bytes.indexOf(10);
        if (newline >= 0) { bytes = bytes.subarray(0, newline + 1); end = true; }
        if (!bytes.length) throw new Error("stale_cursor");
        chunks.push(bytes); length += bytes.length;
      }
      const bytes = Buffer.concat(chunks);
      const nextJson = structuredClone(json);
      checkJson(nextJson, bytes, end);
      const validation = nextJson.limited ? "validation_limit" : nextJson.corrupt ? "corrupt" : end ? "json" : "fragment";
      const nextOffset = offset + length;
      const cursor: Cursor = { version: 1, action: "read", identity: query.historyId, groupId, cut,
        index: nextOffset, entryOffset: end ? nextOffset : entryOffset, json: end ? jsonState() : nextJson };
      const item = { historyId: query.historyId, entryOffset, byteOffset: offset, endsEntry: end,
        encoding: "base64", data: bytes.toString("base64"), validation };
      if (!add(page, item, cursor)) break;
      if ((nextJson.corrupt || nextJson.limited) && page.diagnostics.length < 32)
        page.diagnostics.push({ code: nextJson.limited ? "json_validation_limit" : "corrupt_entry", detail: `byte ${entryOffset}` });
      offset = nextOffset;
      if (end) entryOffset = offset;
      json = end ? jsonState() : nextJson;
    }
    validateCut(fd, cut);
    if (offset < cut.size) page.cursor = encode({ version: 1, action: "read", identity: query.historyId, groupId,
      cut, index: offset, entryOffset, json });
  } finally { closeSync(fd); }
}

export async function queryHistory(input: HistoryQuery, coordinatorSessionId?: string, agentDir = getAgentDir()): Promise<HistoryPage> {
  const page: HistoryPage = { items: [], diagnostics: [], cursor: null };
  try {
    const limit = input.limit ?? 50;
    const allowed = input.action === "list" ? ["action", "scope", ...selectors, "cursor", "limit"] : ["action", "historyId", "groupId", "cursor", "limit"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("invalid_parameter");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid_limit");
    if (input.action === "list") {
      if (input.scope !== undefined && input.scope !== "all") throw new Error("invalid_scope");
      for (const key of selectors) if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key] || input[key]!.length > 200))
        throw new Error("invalid_selector");
      const query = { ...input };
      if (!query.scope && !selectors.some((key) => query[key] !== undefined)) {
        if (!coordinatorSessionId) throw new Error("coordinator_identity_unavailable");
        query.coordinatorSessionId = coordinatorSessionId;
      }
      const directory = path.join(agentDir, "pitako", "worker-history");
      try { if (!lstatSync(directory).isDirectory()) throw new Error("catalog_unreadable"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        page.diagnostics.push({ code: "catalog_missing" }); return page;
      }
      await list(query, page, directory, limit);
    } else if (input.action === "read") await read(input, page, path.join(agentDir, "pitako", "worker-history"), limit);
    else throw new Error("invalid_action");
    if (!page.diagnostics.length) page.diagnostics.push({ code: "ok" });
  } catch (error) {
    page.items = [];
    page.cursor = null;
    page.diagnostics = [{ code: error instanceof Error ? error.message.slice(0, 200) : "history_unavailable" }];
  }
  return page;
}

export function parseHistoryCommand(args: string): HistoryQuery {
  if (args.length > 8192) throw new Error("history command exceeds input limit");
  const [action, ...parts] = args.trim().split(/\s+/);
  if (action !== "list" && action !== "read") throw new Error("history supports list and read only");
  const input: Record<string, unknown> = { action };
  if (action === "read") {
    const historyId = parts.shift();
    if (!historyId || !UUID.test(historyId)) throw new Error("history read requires historyId");
    input.historyId = historyId;
  }
  while (parts.length) {
    const flag = parts.shift()!;
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    if (!flag.startsWith("--") || !["cursor", "limit", ...(action === "list" ? ["scope", ...selectors] : [])].includes(key) ||
        input[key] !== undefined) throw new Error("invalid history flag");
    const value = parts.shift();
    if (!value || value.startsWith("--")) throw new Error(`missing ${flag} value`);
    input[key] = key === "limit" ? Number(value) : value;
  }
  return input as HistoryQuery;
}
