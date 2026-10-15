import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, opendirSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HistoryGroup, HistoryMember, ConsultationLocator } from "./history.ts";
import { catalogValues, checkJson, fileCut, HISTORY_BYTES, HISTORY_FRAGMENT, jsonState, nativeHeader, validateCut, window, type FileCut, type JsonState } from "./history-native.ts";

export type HistoryQuery =
  | { action: "list"; scope?: "all"; coordinatorSessionId?: string; missionId?: string;
      assignmentId?: string; instanceId?: string; roleId?: string; unitId?: string; attemptId?: string; cursor?: string; limit?: number }
  | { action: "read"; historyId?: string; dispatchId?: string; source?: "worker" | "coordinator" | "caller"; groupId?: string; cursor?: string; limit?: number };
export interface HistoryPage {
  items: unknown[];
  diagnostics: Array<{ code: string; detail?: string }>;
  cursor: string | null;
}
/** Internal UI authority, never accepted from public tool parameters. */
export interface HistoryScope {
  coordinatorSessionId: string;
  instanceId?: string;
  assignmentId?: string;
}
function permitted(member: HistoryMember, scope: HistoryScope): boolean {
  return member.coordinatorSessionId === scope.coordinatorSessionId &&
    (scope.instanceId === undefined || member.instanceId === scope.instanceId) &&
    (scope.assignmentId === undefined || member.assignmentId === scope.assignmentId);
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
export function* groupIds(directory: string, after = ""): Generator<string> {
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
  for (const row of catalogValues(fd)) if (row.key !== "members" && row.key !== "consultations") fields[row.key] = row.value;
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
      member.consultation !== undefined && (!UUID.test(member.consultation.dispatchId) || !UUID.test(member.consultation.groupId) ||
        member.consultation.decisionId !== undefined && !UUID.test(member.consultation.decisionId)) ||
      !Array.isArray(member.gaps) || !member.gaps.every((gap) => typeof gap === "string") || !member.native ||
      !(member.native.state === "not-created" || member.native.state === "pruned" || member.native.state === "allocated" &&
        typeof member.native.path === "string" && typeof member.native.sessionId === "string" && member.native.disposition &&
        ["pending", "disposed", "unknown"].includes(member.native.disposition.state)))
      throw new Error("corrupt_catalog");
    yield { member, index: row.index! };
  }
}

function* consultations(fd: number): Generator<{ locator: ConsultationLocator; index: number }> {
  for (const row of catalogValues(fd)) if (row.key === "consultations") {
    const locator = row.value as ConsultationLocator;
    if (!locator || !UUID.test(locator.dispatchId) || typeof locator.roleId !== "string" ||
        typeof locator.instanceId !== "string" || !Array.isArray(locator.gaps) || !locator.gaps.every(gap => typeof gap === "string") ||
        !locator.closure || !["pending", "released", "unknown"].includes(locator.closure.state) ||
        locator.callerSessionFile !== undefined && (typeof locator.callerSessionFile !== "string" || !path.isAbsolute(locator.callerSessionFile)) ||
        locator.callerSessionId !== undefined && typeof locator.callerSessionId !== "string" ||
        locator.version !== undefined && locator.version !== 1 || locator.decisionId !== undefined && !UUID.test(locator.decisionId) ||
        locator.callerHeadInstanceId !== undefined && typeof locator.callerHeadInstanceId !== "string" ||
        locator.followupInstances !== undefined && (!Array.isArray(locator.followupInstances) || locator.followupInstances.length > 32 ||
          !locator.followupInstances.every(id => typeof id === "string") || new Set(locator.followupInstances).size !== locator.followupInstances.length)) throw new Error("corrupt_consultation_locator");
    yield { locator, index: row.index! };
  }
}

function matches(query: Extract<HistoryQuery, { action: "list" }>, group: HistoryGroup, member: HistoryMember): boolean {
  return selectors.every((key) => query[key] === undefined || (key === "missionId"
    ? group.identity.kind === "mission" && group.identity.missionId === query.missionId
    : member[key] === query[key]));
}

function add(page: HistoryPage, item: unknown, cursor: Cursor, byteBudget: number): boolean {
  // Reserve room for diagnostics and the continuation, measuring bytes rather than JS characters.
  if (Buffer.byteLength(JSON.stringify({ ...page, items: [...page.items, item], cursor: encode(cursor) })) > byteBudget - 4096)
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

async function list(query: Extract<HistoryQuery, { action: "list" }>, page: HistoryPage, directory: string, limit: number, scope: HistoryScope | undefined, byteBudget: number) {
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
      if (scope) {
        let authorized = false;
        for (const { member } of members(fd)) if (permitted(member, scope)) { authorized = true; break; }
        if (!authorized) {
          if (previous?.groupId === groupId) throw new Error("history_outside_scope");
          continue;
        }
      }
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
      let consultationCount = 0;
      for (const row of consultations(fd)) consultationCount = row.index + 1;
      if (!catalogCount && !consultationCount && start === 0 && matchesEmpty) {
        const item = { kind: "group", groupId, identity: group.identity, workspace: group.workspace,
          ...(group.identity.kind === "mission" ? {} : { coverage: group.coverage }), ...authority, historyState: "no_member_record" };
        if (page.items.length >= limit || !add(page, item, current(1), byteBudget)) {
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
        if (page.items.length >= limit || !add(page, item, current(index + 1), byteBudget)) {
          // A single summary that cannot fit is explicit, not an endless cursor.
          if (!page.items.length)
            throw new Error("summary_limit");
          page.cursor = encode(current(index)); return;
        }
        last = index + 1;
      }
      if (!scope) for (const { locator, index: locatorIndex } of consultations(fd)) {
        const index = catalogCount + locatorIndex;
        if (index < start) continue;
        if (selectors.some(key => query[key] !== undefined && (key === "missionId" || key === "attemptId" || key === "unitId" ||
          key === "assignmentId" || locator[key as "coordinatorSessionId" | "instanceId" | "roleId"] !== query[key]))) continue;
        const { callerSessionFile: _file, ...visible } = locator;
        const item = { kind: "consultation", groupId, ...visible, ...(group.prunedAt ? { historyState: "pruned" } : {}),
          evidence: "native caller entries required; locator is not a persistence receipt" };
        if (page.items.length >= limit || !add(page, item, current(index + 1), byteBudget)) {
          if (!page.items.length) throw new Error("summary_limit");
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

async function read(query: Extract<HistoryQuery, { action: "read" }>, page: HistoryPage, directory: string, limit: number, scope: HistoryScope | undefined, byteBudget: number, coordinatorSessionId?: string) {
  if (query.groupId !== undefined && !UUID.test(query.groupId)) throw new Error("invalid_group_id");
  let found: Awaited<ReturnType<typeof locate>>;
  let caller: ConsultationLocator | undefined;
  let callerGroup: string | undefined;
  if (query.dispatchId !== undefined) {
    if (!UUID.test(query.dispatchId) || query.historyId !== undefined || query.source && query.source !== "caller") throw new Error("invalid_consultation_selector");
    if (!coordinatorSessionId || scope) throw new Error("history_outside_scope");
    let scans = 0;
    for (const groupId of query.groupId ? [query.groupId] : groupIds(directory)) {
      const fd = catalog(directory, groupId);
      try {
        const group = metadata(fd, groupId);
        for (const { locator } of consultations(fd)) if (locator.dispatchId === query.dispatchId && locator.coordinatorSessionId === coordinatorSessionId) {
          caller = locator; callerGroup = groupId;
          if (group.prunedAt) page.diagnostics.push({ code: "caller_catalog_pruned_caller_retained" });
          if (group.cleanup) page.diagnostics.push({ code: "history_deletion_incomplete" });
          break;
        }
      } finally { closeSync(fd); }
      if (caller) break;
      if (++scans >= 200) throw new Error("catalog_scan_limit");
    }
    if (!caller) throw new Error("consultation_not_found_in_caller_scope");
  } else {
    if (!query.historyId || !UUID.test(query.historyId)) throw new Error("invalid_history_id");
    found = await locate(directory, query.historyId, query.groupId);
    if (!found) throw new Error(query.cursor ? "stale_cursor" : "history_not_found");
  }
  const member = found?.member;
  const groupId = callerGroup ?? found!.groupId;
  const source = caller ? "caller" : query.source ?? "worker";
  if (!["worker", "coordinator", "caller"].includes(source) || source === "caller" && !caller) throw new Error("invalid_source");
  if (scope && (!member || !permitted(member, scope))) throw new Error("history_outside_scope");
  const callerId = caller?.callerSessionId ?? member?.coordinatorSessionId;
  const callerFile = caller?.callerSessionFile ?? member?.coordinatorSessionFile;
  const identity = createHash("sha256").update(JSON.stringify([query.historyId, query.dispatchId, source, callerId, callerFile, scope])).digest("hex");
  const previous = decode(query.cursor, "read", identity);
  if (previous && previous.groupId !== groupId) throw new Error("stale_cursor");
  if (found?.deleting) page.diagnostics.push({ code: "history_deletion_incomplete" });
  if (source === "worker" && member?.native.state === "pruned") {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: "history_pruned" }); return;
  }
  if (member?.gaps?.length) page.diagnostics.push({ code: "capture_gaps",
    detail: `${member.gaps.join("; ").slice(0, 1024)} (catalog diagnostics; detail limited to 1024 characters)` });
  if (source === "worker" && member?.native.state === "not-created") {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: "native_not_created", detail: "No allocated native locator was recorded; this is not proof of no worker activity." }); return;
  }
  if (source !== "worker" && (!callerId || !callerFile || !path.isAbsolute(callerFile))) {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: "coordinator_locator_unavailable" }); return;
  }
  if (caller?.gaps.length) page.diagnostics.push({ code: "consultation_capture_gaps", detail: caller.gaps.join("; ").slice(0, 1024) });
  const file = source !== "worker" ? callerFile! :
    member?.native.state === "allocated" ? member.native.path : "";
  page.diagnostics.push(sidecar(file));
  let fd: number;
  try {
    if (!lstatSync(file).isFile()) throw new Error("native_unreadable");
    fd = openSync(file, "r");
  } catch (error) {
    if (previous) throw new Error("stale_cursor");
    page.diagnostics.push({ code: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? source === "caller" ? "caller_native_missing_or_not_persisted_before_assistant" : source === "coordinator" ? "coordinator_native_missing" :
        member?.terminal?.beforeFirstAssistant ? "native_not_persisted_before_assistant" : "native_missing" : "native_unreadable" });
    return;
  }
  try {
    if (previous) validateCut(fd, previous.cut);
    const cut = previous?.cut ?? fileCut(fd);
    if (source !== "worker") {
      let header;
      try { header = nativeHeader(fd); } catch { throw new Error("coordinator_native_header_invalid"); }
      if (header?.type !== "session" || header.id !== callerId)
        throw new Error("coordinator_native_header_mismatch");
    }
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
      const cursor: Cursor = { version: 1, action: "read", identity, groupId, cut,
        index: nextOffset, entryOffset: end ? nextOffset : entryOffset, json: end ? jsonState() : nextJson };
      const item = { ...(caller ? { dispatchId: query.dispatchId } : { historyId: query.historyId }), source, entryOffset, byteOffset: offset, endsEntry: end,
        encoding: "base64", data: bytes.toString("base64"), validation };
      if (!add(page, item, cursor, byteBudget)) break;
      if ((nextJson.corrupt || nextJson.limited) && page.diagnostics.length < 32)
        page.diagnostics.push({ code: nextJson.limited ? "json_validation_limit" : "corrupt_entry", detail: `byte ${entryOffset}` });
      offset = nextOffset;
      if (end) entryOffset = offset;
      json = end ? jsonState() : nextJson;
    }
    validateCut(fd, cut);
    if (offset < cut.size) page.cursor = encode({ version: 1, action: "read", identity, groupId,
      cut, index: offset, entryOffset, json });
  } finally { closeSync(fd); }
}

export async function queryHistory(input: HistoryQuery, coordinatorSessionId?: string, agentDir = getAgentDir(), scope?: HistoryScope, byteBudget = HISTORY_BYTES): Promise<HistoryPage> {
  const page: HistoryPage = { items: [], diagnostics: [], cursor: null };
  try {
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 16 * 1024 || byteBudget > HISTORY_BYTES) throw new Error("invalid_budget");
    const limit = input.limit ?? 50;
    const allowed = input.action === "list" ? ["action", "scope", ...selectors, "cursor", "limit"] : ["action", "historyId", "dispatchId", "source", "groupId", "cursor", "limit"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("invalid_parameter");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid_limit");
    if (scope && (!scope.coordinatorSessionId || input.action === "read" && input.source && input.source !== "worker" ||
      input.action === "list" && (input.scope || selectors.some(key =>
        input[key] !== undefined && input[key] !== scope[key as keyof HistoryScope]))))
      throw new Error("history_outside_scope");
    if (input.action === "list") {
      if (input.scope !== undefined && input.scope !== "all") throw new Error("invalid_scope");
      for (const key of selectors) if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key] || input[key]!.length > 200))
        throw new Error("invalid_selector");
      const query = { ...input };
      if (scope) Object.assign(query, scope);
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
      await list(query, page, directory, limit, scope, byteBudget);
    } else if (input.action === "read") await read(input, page, path.join(agentDir, "pitako", "worker-history"), limit, scope, byteBudget, coordinatorSessionId);
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
    if (!flag.startsWith("--") || !["cursor", "limit", ...(action === "list" ? ["scope", ...selectors] : ["source", "groupId"])].includes(key) ||
        input[key] !== undefined) throw new Error("invalid history flag");
    const value = parts.shift();
    if (!value || value.startsWith("--")) throw new Error(`missing ${flag} value`);
    input[key] = key === "limit" ? Number(value) : value;
  }
  return input as HistoryQuery;
}

/** Bounded projection over catalog-authorized callers; no caller-provided path is opened. */
export async function consultationStats(coordinatorSessionId: string | undefined, dispatchId?: string, agentDir = getAgentDir()) {
  if (!coordinatorSessionId) throw new Error("coordinator_identity_unavailable");
  if (dispatchId !== undefined && !UUID.test(dispatchId)) throw new Error("invalid_dispatch_id");
  const listing = await queryHistory({ action: "list", coordinatorSessionId, limit: 200 }, coordinatorSessionId, agentDir);
  const rows: unknown[] = [];
  const diagnostics = [...listing.diagnostics];
  if (listing.cursor) diagnostics.push({ code: "consultation_listing_limited", detail: "More catalog rows omitted; use agent_history pagination" });
  // Only the authorized listing supplies locators. A bounded scan never invents absent coverage.
  type CatalogRow = (HistoryMember & { kind: "member"; groupId: string }) | (ConsultationLocator & { kind: "consultation"; groupId: string });
  const items = listing.items as CatalogRow[];
  const locators = items.filter((item): item is Extract<CatalogRow, { kind: "consultation" }> => item.kind === "consultation" && (!dispatchId || item.dispatchId === dispatchId));
  const headCallers = new Set<string>();
  for (const locator of locators) if (locator.callerHeadInstanceId && locator.callerSessionId && !headCallers.has(locator.callerSessionId)) {
    if (headCallers.size >= 16) { diagnostics.push({ code: "consultation_descendant_listing_limited" }); break; }
    headCallers.add(locator.callerSessionId);
    const descendants = await queryHistory({ action: "list", coordinatorSessionId: locator.callerSessionId, limit: 200 }, coordinatorSessionId, agentDir);
    diagnostics.push(...descendants.diagnostics);
    if (descendants.cursor) diagnostics.push({ code: "consultation_descendant_listing_limited" });
    for (const item of descendants.items as typeof items) if (item.kind === "member" && item.head?.headInstanceId === locator.callerHeadInstanceId &&
      !items.some(existing => existing.kind === "member" && existing.historyId === item.historyId)) items.push(item);
  }
  const counted = new Set<string>();
  const budget = { bytes: 4 * 1024 * 1024, reads: 32 };
  let omittedRows = 0;
  for (const locator of locators) {
    const caller = await projectedEntries({ dispatchId: locator.dispatchId, groupId: locator.groupId, source: "caller" }, coordinatorSessionId, agentDir, budget);
    diagnostics.push(...caller.diagnostics);
    const events = caller.entries.filter(value => value.type === "custom" && value.customType === "pitako.consultation" &&
      value.data?.version === 1 && value.data.dispatchId === locator.dispatchId).map(value => value.data);
    const decision = [...events].reverse().find(event => event.event === "decision");
    const feedback = [...events].reverse().find(event => event.event === "feedback");
    const attempts: unknown[] = [], followups: unknown[] = [];
    let truncated = caller.truncated;
    const linked = new Set<string>(feedback?.data?.followupInstances ?? []);
    for (const member of items.filter((item): item is Extract<CatalogRow, { kind: "member" }> => item.kind === "member" &&
      (item.consultation?.dispatchId === locator.dispatchId || linked.has(item.instanceId ?? "")))) {
      const native = await projectedEntries({ historyId: member.historyId, groupId: member.groupId }, coordinatorSessionId, agentDir, budget);
      diagnostics.push(...native.diagnostics); truncated ||= native.truncated;
      const results = native.entries.filter(value => value.type === "custom" && value.customType === "pitako.worker-history" &&
        value.data?.event === "result");
      for (const entry of results) {
        const result = entry.data.data;
        const id = result?.resultId;
        const duplicate = !id || counted.has(id);
        if (id) counted.add(id);
        const row = { instanceId: member.instanceId, historyId: member.historyId, resultId: id ?? null,
          status: result?.status, at: result?.at, admittedAt: member.admittedAt, closure: member.terminal ?? null, target: result?.target, provenance: result?.provenance,
          usage: duplicate ? null : result?.usage ?? null, duplicateOrLegacy: duplicate,
          usageSource: result?.usageSource ?? "unavailable", gap: result?.gap };
        (linked.has(member.instanceId ?? "") ? followups : attempts).push(row);
      }
      if (!results.length) (linked.has(member.instanceId ?? "") ? followups : attempts).push({ historyId: member.historyId,
        instanceId: member.instanceId, admittedAt: member.admittedAt, closure: member.terminal ?? null, usage: null, gap: "no physically persisted attempt result in bounded scan" });
    }
    for (const id of linked) if (!items.some(item => item.kind === "member" && item.instanceId === id))
      followups.push({ instanceId: id, usage: null, gap: "linked instance outside bounded catalog coverage" });
    const row = { dispatchId: locator.dispatchId, events, gaps: locator.gaps,
      evidence: events.length ? "physically-persisted" : "absent-or-not-persisted-before-first-assistant",
      classifier: { identity: decision?.data?.classifier ?? null, callStartedAt: decision?.data?.callStartedAt ?? null,
        callCompletedAt: decision?.data?.callCompletedAt ?? null, usage: decision?.data?.response?.usage ?? decision?.data?.usage ?? null,
        evidence: decision?.data?.evidence ?? "unavailable" },
      attempts, followups, latestFeedback: feedback ?? null, feedbackCoverage: !events.length ? "unavailable caller evidence" : truncated ? "latest observed prefix only; later corrections may be omitted" : "complete captured native file cut",
      intervals: events.filter(event => ["preparation", "outcome", "closure", "delivery"].includes(event.event))
        .map(event => ({ event: event.event, at: event.at, data: event.event === "outcome" ? undefined : event.data })),
      combinedTotal: null, accounting: "Separate observations only. Inclusive Head/descendant overlap cannot be separated. Unknown is not zero; catalog pricing is not a billing receipt. Links show association, not cause.",
      truncated };
    if (Buffer.byteLength(JSON.stringify({ rows: [...rows, row], diagnostics: diagnostics.slice(0, 32) })) > HISTORY_BYTES - 4096) {
      omittedRows++; continue;
    }
    rows.push(row);
  }
  if (omittedRows) diagnostics.push({ code: "consultation_projection_limited", detail: `${omittedRows} rows omitted; read original entries with agent_history` });
  if (dispatchId && !rows.length) diagnostics.push({ code: "consultation_not_found_in_bounded_caller_scope" });
  return { rows, omittedRows, diagnostics: diagnostics.slice(0, 32), diagnosticsOmitted: Math.max(0, diagnostics.length - 32),
    coverage: "bounded native observations; incomplete when catalog/pages/records are absent or limited", combinedTotal: null };
}

/** Decode the existing lossless paged reader, with a separate finite projection budget. */
async function projectedEntries(selector: { dispatchId?: string; historyId?: string; groupId: string; source?: "caller" },
  coordinatorSessionId: string, agentDir: string, budget: { bytes: number; reads: number }) {
  if (budget.reads-- <= 0 || budget.bytes <= 0) return { entries: [], diagnostics: [{ code: "consultation_native_scan_limited" }], truncated: true };
  const entries: any[] = [], diagnostics: HistoryPage["diagnostics"] = [];
  let cursor: string | undefined, entry = Buffer.alloc(0), scanned = 0, truncated = false;
  do {
    const page = await queryHistory({ action: "read", ...selector, cursor, limit: 200 }, coordinatorSessionId, agentDir);
    diagnostics.push(...page.diagnostics.filter(row => row.code !== "native_physical_order" && row.code !== "sidecar_missing"));
    if (!page.diagnostics.some(row => row.code === "native_physical_order") || page.diagnostics.some(row => row.code === "partial_tail")) truncated = true;
    for (const item of page.items as Array<{ data: string; endsEntry: boolean }>) {
      const bytes = Buffer.from(item.data, "base64"); scanned += bytes.length; budget.bytes -= bytes.length;
      if (scanned > 1024 * 1024 || budget.bytes < 0) { truncated = true; break; }
      entry = Buffer.concat([entry, bytes]);
      if (item.endsEntry) {
        try { entries.push(JSON.parse(entry.toString("utf8"))); }
        catch { diagnostics.push({ code: "corrupt_projection_entry" }); truncated = true; }
        entry = Buffer.alloc(0);
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor && !truncated);
  if (entry.length) { diagnostics.push({ code: "incomplete_projection_entry" }); truncated = true; }
  return { entries, diagnostics, truncated };
}
